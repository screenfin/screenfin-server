import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ROOM_SETTINGS,
  MAX_LOBBY_GROUPS,
  createServerMessage,
  expectedPositionMs,
  type ClientMessageOf,
  type LobbyGroup,
  type Participant,
  type RoomRemovalReason,
  type RoomSettings,
  type RoomState,
  type RoomStateCause,
  type ServerMessage,
  type SyncConfig,
} from '@screenfin/protocol';
import { DomainError } from '../errors';
import { participantIsLive } from '../liveness';
import { createKeyedTokenBuckets, type KeyedTokenBuckets } from '../rateLimit';
import type { ItemVisibility } from '../visibility';
import type { PersistedRoom } from './persistence';
import type { Room, RoomStore, TimerHandle } from './store';

type RoomCreatePayload = ClientMessageOf<'room.create'>['payload'];
type SetItemPayload = ClientMessageOf<'playback.setItem'>['payload'];
type QueueSetPayload = ClientMessageOf<'queue.set'>['payload'];
type ClientPositionPayload = ClientMessageOf<'client.position'>['payload'];
type ClientBufferingPayload = ClientMessageOf<'client.buffering'>['payload'];

/** A seat whose holdings are released and whose removal from the state is still to come. */
interface ReleasedSeat {
  participantId: string;
  wasHost: boolean;
  /** The room's hold was waiting on it, so removing it may resume the room. */
  wasWaitedOn: boolean;
}

export interface ParticipantInfo {
  participantId: string;
  userId: string;
  userName: string;
  /**
   * What this device calls itself (`session.hello.payload.client.deviceName`). Optional on the
   * wire, so every use of it must read as well without one. Held only to name the *other* device
   * when this account is refused a second seat in one room; it never reaches the wire, because
   * `Participant` is a broadcast type and the room does not need to publish everybody's hardware.
   */
  deviceName?: string;
  /**
   * The account's Jellyfin maturity ceiling (`Policy.MaxParentalRating`), or null / absent when it
   * has none — the maturity rule. Read off `/Users/Me` beside the identity and held in
   * the live session; the router passes the session's copy. The room keeps it beside the device
   * name for exactly as long as the seat lasts, and it never reaches the wire: `Participant` is a
   * broadcast type, and what the room publishes is the ladder's *name* for the lowest ceiling
   * seated, in `playback.maturityRating`.
   */
  maturityCeiling?: number | null;
}

/** `deviceName` as it may be shown: an untrusted ≤64-char string from the client. */
function displayableDeviceName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // Control characters would land in an error message a client renders. Strip rather than reject:
  // the sentence still has a fallback, and a device with an odd name is not a protocol violation.
  const cleaned = raw.replace(/[\p{C}]/gu, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * The one sentence for "you are already in this party somewhere else", written once so the
 * with-a-name and without-a-name forms cannot drift apart.
 *
 * Naming the device is most of the value: "already watching on Living Room TV" tells somebody
 * which room of the house to walk to, where "on another device" leaves them guessing at exactly
 * the moment they are being refused something.
 */
export function joinedOnAnotherDeviceMessage(deviceName: string | null): string {
  return deviceName === null
    ? 'You are already in this party on another device. Leave the party there first.'
    : `You are already in this party on ${deviceName}. Leave the party there first.`;
}

/**
 * The one sentence for "this party's media is above your Jellyfin account's
 * maturity ceiling".
 *
 * Deliberately says nothing about *which* item or *what* rating. The room is
 * already hidden from this account's lobby, so anybody reaching this refusal
 * either has a stale roster or joined by id; naming the film would hand back
 * exactly the metadata Jellyfin is withholding.
 */
export function maturityJoinRefusalMessage(): string {
  return (
    'This party is playing media your Jellyfin account is not allowed to watch, ' +
    'so it cannot be joined.'
  );
}

/**
 * The wire code for the two "not finished asking" sentences below.
 *
 * **It says what it means, as of the wire change that added it.** This shipped
 * first as `INTERNAL` — the only retryable code left once `FORBIDDEN` was ruled
 * out (every client renders that as the maturity rule's final maturity refusal, and this is
 * a check that has not run), `RATE_LIMITED` means a token bucket, and
 * `AUTH_UNAVAILABLE` is the handshake's, which closes the socket. `INTERNAL`'s
 * contract was right and its name was a lie: "unexpected server failure" for
 * work the relay simply has not finished. `VISIBILITY_PENDING` carries the same
 * contract under its own name (`PROTOCOL.md` § 8.1, § 14).
 *
 * The mechanics it depends on are unchanged: `errors.ts` defaults it to
 * retryable, `router.ts` deliberately does not cache a retryable reply against
 * its message id so the same frame really can be re-sent, and the natives read
 * a retryable refusal as "not final" (`SyncClient.rejoinRefused` keeps the
 * party up rather than tearing the room down). Clients built before the code
 * existed decode it tolerantly — Swift to `.unknown(_)`, Kotlin to
 * `ErrorCode.UNKNOWN` — and still see `retryable: true` and the sentence.
 */
const VISIBILITY_PENDING_CODE = 'VISIBILITY_PENDING' as const;

/**
 * The shortest gap between two on-arrival broadcasts of one seat's `playerState`
 * change (PROTOCOL.md § 11). A quarter of the default presence window: a real
 * `loading` → `ready` → `playing` run still lands well inside a second, and a
 * seat flipping state on every report costs the room at most one on-arrival
 * snapshot and one deferred flush per window — four a second, however fast it
 * flips.
 */
export const STATE_FLUSH_MIN_INTERVAL_MS = 500;

/** The player states that mean a seat is watching, the first pool `pickNewHost` reads. */
const WATCHING_STATES: ReadonlySet<Participant['playerState']> = new Set([
  'playing',
  'paused',
  'buffering',
]);

/**
 * What one ordinary Jellyfin account may make the relay hold and ask for (security review
 * 2026-09-25, H1 and M1). Every one of them is per **account** — a household's ten sessions share
 * one budget — except `maxRooms`, which is the whole relay's.
 *
 * Refusals are `RATE_LIMITED`, retryable: the existing code every client already treats as "not
 * now", so no client needs to learn anything new.
 */
export interface RoomLimits {
  /** Rooms the relay holds at once, live and idle (`MAX_ROOMS`). */
  maxRooms: number;
  /**
   * Rooms one account holds at once, live and idle (`MAX_ROOMS_PER_USER`). At the cap, a create
   * replaces that account's own longest-idle room; it is refused only when all of them are live.
   */
  maxRoomsPerUser: number;
  /** `room.create`s an account may make back to back… */
  createBurst: number;
  /** …and how fast that allowance comes back. */
  createsPerMinute: number;
  /** `queue.set` + `playback.setItem`, together, an account may make back to back… */
  addBurst: number;
  /** …and how fast that allowance comes back. */
  addsPerSecond: number;
  /**
   * Item ids **new to the room** one account may put in front of the relay per minute. Each is a
   * question to Jellyfin for every account connected, so this — not the press rate — is
   * what bounds the load a host can put on Jellyfin and on the visibility cache.
   */
  newItemsPerMinute: number;
}

/**
 * The defaults. `maxRooms` is `MAX_LOBBY_GROUPS`, so the lobby never has to truncate; the rest are
 * far above anything a real household does — a party is created once an evening, and a queue
 * is edited by hand — and far below the flood the review measured (1,100 rooms in 18 s).
 */
export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  maxRooms: MAX_LOBBY_GROUPS,
  maxRoomsPerUser: 5,
  createBurst: 5,
  createsPerMinute: 10,
  addBurst: 5,
  addsPerSecond: 2,
  // Two full 500-entry queues a minute, each pressed twice (the first press waits on the maturity
  // rule).
  newItemsPerMinute: 2_000,
};

/** Accounts tracked by the per-account buckets before full ones are forgotten. */
const MAX_TRACKED_ACCOUNTS = 10_000;

/** What one account's answers say about a whole room. */
type RoomWatchability = 'watchable' | 'withheld' | 'unresolved';

/**
 * The two sentences for "the relay has not finished asking".
 *
 * Deliberately **not** `maturityJoinRefusalMessage` and
 * `maturityAddRefusalMessage`, and the difference is the whole point of having
 * four sentences instead of two. The maturity rule's are final statements about a person's
 * Jellyfin account — *"your account is not allowed to watch this"*, *"X is in
 * this party and is not allowed to watch this media due to their maturity
 * level"* — and no maturity judgement has
 * been made when these are thrown. Repeating either here would invent one, and
 * a client that rendered it would tell somebody they had been refused for their
 * ceiling when in fact nobody had looked yet.
 *
 * They say what is true and what to do about it: the check has not finished,
 * and the same action a second from now will get a real answer, because the
 * door that refused also asked for one (`RoomManagerDeps.requestVisibility`).
 */
export function maturityJoinPendingMessage(): string {
  return (
    'The relay is still checking whether your Jellyfin account may watch this party. ' +
    'Try joining again in a moment.'
  );
}

/** The add door's half of `maturityJoinPendingMessage`; see its note. */
export function maturityAddPendingMessage(): string {
  return (
    'The relay is still checking whether everyone in this party may watch that media. ' +
    'Try adding it again in a moment.'
  );
}

/**
 * The one sentence for "adding this would exclude somebody already sitting
 * here", naming them **and the reason**.
 *
 * Naming is the whole point: the operator rejected eviction twice, so the host
 * has to be told who the constraint belongs to in order to act on it — the
 * choice is theirs (pick something else, or ask that person to leave), and a
 * bare "not allowed" leaves them with no move. Bounded at three names because
 * a room may hold a hundred and this is one line of UI.
 *
 * The wording is the product's: _"{User} is in
 * this party and not allowed to watch this media due to their Maturity
 * Level."_ Clients put it under the title **"Could not add"**,
 * so the sentence itself no longer says "cannot be added".
 */
export function maturityAddRefusalMessage(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  // One "and" per sentence: the tail takes it when there is a tail ("Ada, Grace,
  // Linus and 2 others"), the last shown name otherwise ("Ada, Grace and Linus").
  const who =
    rest > 0
      ? `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
      : shown.length === 1
        ? (shown[0] ?? '')
        : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
  const verb = names.length === 1 ? 'is' : 'are';
  return (
    `${who} ${verb} in this party and ${verb} not allowed to watch this media ` +
    'due to their maturity level.'
  );
}

export interface RoomManagerDeps {
  store: RoomStore;
  clock: () => number;
  setTimer: (fn: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  syncConfig: SyncConfig;
  /**
   * Largest number of participants a room accepts. The operator's, from the
   * environment (`MAX_ROOM_PARTICIPANTS`): fixed for the life of the
   * process, like every other relay setting.
   */
  maxParticipants: number;
  /**
   * How long a room with no participants is held before it is removed. The
   * window exists so a page reload, a walk to the kitchen, or a relay restart
   * does not destroy a party that is about to be rejoined. 0 removes the room
   * the moment it empties.
   */
  emptyRoomTtlMs: number;
  /**
   * How long a seat may report `buffering` without a break, while the room's timeline runs and
   * somebody else is connected, before it is removed from the room with the reason
   * (`STALLED_SEAT_REMOVE_MS`, the stalled-seat rule, PROTOCOL.md § 13.4). 0 turns the removal off.
   */
  stalledSeatRemoveMs: number;
  /**
   * Serialize the message ONCE and hand the same frame to every recipient,
   * synchronously, before returning. The manager passes live room state rather
   * than a copy, so an implementation that defers serialization would observe
   * later mutations through an already-sent message.
   */
  broadcast: (roomId: string, message: ServerMessage, opts?: { except?: string }) => void;
  sendTo: (participantId: string, message: ServerMessage) => void;
  /** Re-push the lobby roster to every connected session. */
  broadcastLobby: () => void;
  /**
   * Ask Jellyfin about these accounts and these items, so a door that has just
   * refused for want of an answer is answered for real on the next attempt
   *.
   *
   * Fire-and-forget, and shaped exactly like `broadcastLobby` for exactly the
   * same reason: the guards below are synchronous, `../router.ts` has no `await`
   * anywhere in it, and the maturity rule records why making the message loop async is not
   * on the table. The implementation warms in the background and must never let
   * the promise reject into the message path.
   *
   * **A refusal is only acceptable if the retry is decided.** Without this, the
   * fail-closed direction the unresolved-state change introduces would be a door that says "try
   * again"
   * and means "and again, and again": nothing else asks about an item the room
   * does not hold yet, because the two existing warm points fire on session
   * welcome and on the item set having *already* changed — and the add is what
   * changes it.
   */
  requestVisibility: (userIds: readonly string[], itemIds: readonly string[]) => void;
  /** Note that room state changed so it is written to durable storage. */
  persist: () => void;
  /**
   * The maturity rule's oracle: has Jellyfin said this account may see this item?
   *
   * Required rather than optional on purpose. Both doors — the lobby filter and
   * the join guard — read it, and a relay wired without one would advertise and
   * seat exactly the parties this exists to withhold, silently. Its answers are
   * synchronous by construction; see `../visibility.ts` for why, and for the
   * miss/error policy the guards depend on.
   */
  visibility: ItemVisibility;
  /** The abuse bounds; any field left out takes `DEFAULT_ROOM_LIMITS`'. */
  limits?: Partial<RoomLimits>;
}

/**
 * How many people are actually watching — which is not how many seats are taken.
 *
 * A dropped socket keeps its seat for `reconnectGraceMs` (60 s by default) so a blip does not end
 * somebody's evening, and `state.participants` rightly still lists them as `reconnecting`. But
 * `LobbyGroup.participantCount` is the only liveness signal the clients have: all four derive
 * `isLive = participantCount > 0` from it, and that is what files a party under "LIVE NOW" with
 * the teal Signal and renders "1 watching". Counting a held seat as a watcher meant a room
 * everybody had closed advertised an occupant for a full minute, and whoever answered it found an
 * empty room.
 *
 * So a room reports 0 only when **every** seat is held by a socket that has gone. A partially
 * disconnected room still reports its full seat count, deliberately: those seats really are
 * reserved, `joinRoom` really will refuse at `capacity`, and reporting the smaller number would
 * clear "Full" off a room that is full and turn a 60-second overstatement into an invitation the
 * relay then rejects with `ROOM_FULL`. The remaining overstatement — a *full* room whose members
 * all blip at once briefly reading as joinable — is far rarer than a party simply ending, and it
 * fails as a clean refusal rather than as a lie.
 *
 * `[].every()` is `true`, so a genuinely empty idle room falls out of this at 0 as well.
 */
function occupantCount(room: Room): number {
  return room.state.participants.every((p) => p.connection === 'reconnecting')
    ? 0
    : room.state.participants.length;
}

/**
 * Every item the room holds: what is playing **and** the whole queue.
 *
 * The maturity rule's level is a maximum over this set rather than over the current item,
 * which is also why it does not flicker as the queue advances.
 */
function roomItemIds(room: Room): string[] {
  const playback = room.state.playback;
  const ids = playback.itemId === null ? [] : [playback.itemId];
  for (const entry of playback.queue) ids.push(entry.itemId);
  return ids;
}

// Crockford base32, lowercase: no i/l/o/u. 32 symbols, so `byte & 31` is unbiased.
const ROOM_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ROOM_ID_LENGTH = 8;

function generateRoomId(): string {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let id = '';
  for (const byte of bytes) id += ROOM_ID_ALPHABET.charAt(byte & 31);
  return id;
}

/**
 * Server-authoritative room domain logic. Every mutation materializes the
 * timeline, bumps `revision` by exactly 1, and broadcasts a full `room.state`.
 */
export class RoomManager {
  /** participantId -> roomId (a session is in at most one room). */
  private readonly memberships = new Map<string, string>();
  /**
   * participantId -> the device name that session gave at hello, for the sessions that gave one.
   * Kept in lockstep with `memberships` — a seat and the name of the thing sitting in it have
   * exactly the same lifetime — and read only to write one error message.
   */
  private readonly deviceNames = new Map<string, string>();
  /**
   * participantId -> that account's Jellyfin maturity ceiling, for the seats whose account has
   * one. Same lifetime as `deviceNames` — taken with the seat, released with it — and read only
   * by `refreshMaturity`, which publishes the ladder's name for the lowest one seated, never the
   * number. A seat keeps the ceiling it was taken with: a ceiling
   * edited on Jellyfin mid-party is not a door, and nothing re-evaluates a seated participant.
   */
  private readonly ceilings = new Map<string, number>();
  private readonly limits: RoomLimits;
  /** Per account: `room.create`. */
  private readonly createBuckets: KeyedTokenBuckets;
  /** Per account: `queue.set` and `playback.setItem`, together. */
  private readonly addBuckets: KeyedTokenBuckets;
  /** Per account: item ids new to the room, counted one each. */
  private readonly newItemBuckets: KeyedTokenBuckets;

  constructor(private readonly deps: RoomManagerDeps) {
    this.limits = { ...DEFAULT_ROOM_LIMITS, ...deps.limits };
    const buckets = (ratePerSecond: number, burst: number): KeyedTokenBuckets =>
      createKeyedTokenBuckets({
        clock: deps.clock,
        ratePerSecond,
        burst,
        maxTracked: MAX_TRACKED_ACCOUNTS,
      });
    this.createBuckets = buckets(this.limits.createsPerMinute / 60, this.limits.createBurst);
    this.addBuckets = buckets(this.limits.addsPerSecond, this.limits.addBurst);
    this.newItemBuckets = buckets(
      this.limits.newItemsPerMinute / 60,
      this.limits.newItemsPerMinute,
    );
  }

  // -------------------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------------------

  createRoom(info: ParticipantInfo, payload: RoomCreatePayload): RoomState {
    if (this.memberships.has(info.participantId)) {
      throw new DomainError('ALREADY_IN_ROOM', 'This session already participates in a room');
    }
    // Security review H1: without these, one account's create → leave loop held 1,100 rooms in
    // 18 s, pushed 432 MB of lobby to its own sockets and wrote a rooms document no restart could
    // read. The rate first, because it is about the caller; then the account's own cap, which may
    // make room by retiring one of that account's idle parties; then the relay's.
    if (!this.createBuckets.take(info.userId)) {
      throw new DomainError(
        'RATE_LIMITED',
        'You are starting parties too quickly. Try again in a moment.',
      );
    }
    this.makeRoomForOwner(info.userId);
    if (this.deps.store.size() >= this.limits.maxRooms) {
      throw new DomainError(
        'RATE_LIMITED',
        'This server is holding as many parties as it allows. Try again later.',
      );
    }
    const now = this.deps.clock();
    let roomId = generateRoomId();
    while (this.deps.store.get(roomId) !== undefined) roomId = generateRoomId();

    const host: Participant = {
      participantId: info.participantId,
      userId: info.userId,
      userName: info.userName,
      role: 'host',
      connection: 'connected',
      playerState: 'idle',
      lastPositionMs: null,
      lastReportAt: null,
      joinedAt: now,
    };
    const state: RoomState = {
      roomId,
      name: payload.name ?? null,
      createdAt: now,
      // Created, not started. Latched by the first `play` below — a room with an
      // item sits at `paused` / 0 until somebody presses Start in the lobby.
      startedAt: null,
      revision: 0,
      hostParticipantId: info.participantId,
      // A host who did not choose gets the protocol's fallback, not an
      // operator's: the choice is the host's.
      settings: { ...DEFAULT_ROOM_SETTINGS, ...payload.settings },
      // The maturity pair is derived, not chosen: `snapshot` below materializes
      // it from the visibility cache before this room is first described.
      playback: payload.item
        ? {
            itemId: payload.item.itemId,
            queue: [],
            queueIndex: null,
            maturityRating: null,
            containsUnrated: false,
            state: 'paused',
            positionMs: payload.item.positionMs ?? 0,
            measuredAt: now,
            rate: 1,
          }
        : {
            itemId: null,
            queue: [],
            queueIndex: null,
            maturityRating: null,
            containsUnrated: false,
            state: 'idle',
            positionMs: 0,
            measuredAt: now,
            rate: 1,
          },
      participants: [host],
    };
    const room: Room = {
      state,
      waitingFor: new Set(),
      bufferingTimers: new Map(),
      stallTimers: new Map(),
      graceTimers: new Map(),
      emptySince: null,
      idleTimer: null,
      lastHostName: info.userName,
      // A live room with a host in it has nothing to remember; the chair is occupied.
      hostClaimUserId: null,
      presenceDirty: false,
      presenceTimer: null,
      presenceCauseParticipantId: null,
      presenceTimerDueAt: 0,
      stateFlushAt: new Map(),
      ownerUserId: info.userId,
      holdArmedAt: new Map(),
      deferredHolds: new Set(),
      holdTimer: null,
      holdTimerDueAt: 0,
      endTimer: null,
      endTimerDueAt: 0,
      itemRuntime: null,
    };
    this.deps.store.set(room);
    this.rememberSeat(info, roomId);
    this.deps.persist();
    this.deps.broadcastLobby();
    return this.snapshot(room);
  }

  /**
   * Hold `userId` to `maxRoomsPerUser`: at the cap, retire that account's longest-idle room so the
   * new one fits, and refuse only when every room it holds has somebody in it.
   *
   * Retiring rather than refusing is what keeps the cap from punishing an ordinary host, whose
   * idle rooms are parties they walked out of and are now replacing; and it is still a bound,
   * because a create → leave loop now churns the same five rooms instead of growing. Only the
   * account's own rooms, and only empty ones: nobody else's party ends because of this.
   */
  private makeRoomForOwner(userId: string): void {
    const owned = [...this.deps.store.all()].filter((room) => room.ownerUserId === userId);
    if (owned.length < this.limits.maxRoomsPerUser) return;
    const idle = owned
      .filter((room) => room.state.participants.length === 0)
      .sort((a, b) => (a.emptySince ?? 0) - (b.emptySince ?? 0));
    const retire = owned.length - this.limits.maxRoomsPerUser + 1;
    if (idle.length < retire) {
      throw new DomainError(
        'RATE_LIMITED',
        `You already have ${owned.length} parties open. Close one before starting another.`,
      );
    }
    for (const room of idle.slice(0, retire)) this.closeRoomInternal(room, 'empty');
  }

  /**
   * Charge an add — `playback.setItem` or `queue.set` — to the caller's account (review M1).
   *
   * Two budgets. The press rate, because a host has no use for twenty queue edits a second. And the
   * ids **new to this room**, because each of those becomes a question to Jellyfin under every
   * connected account's token when the lobby is next warmed, and an entry in the shared
   * visibility cache: 500 fresh ids a press was the lever that evicted other parties' answers.
   * Ids the room already holds are free, so reordering or trimming a queue costs one press.
   *
   * Charged before the the maturity rule door on purpose: a press refused here asks Jellyfin
   * nothing.
   */
  private chargeAdd(room: Room, userId: string, itemIds: readonly string[]): void {
    if (!this.addBuckets.take(userId)) {
      throw new DomainError(
        'RATE_LIMITED',
        'Too many changes to the queue. Try again in a moment.',
      );
    }
    const held = new Set(roomItemIds(room));
    const fresh = new Set(itemIds.filter((itemId) => !held.has(itemId)));
    if (fresh.size > 0 && !this.newItemBuckets.take(userId, fresh.size)) {
      throw new DomainError(
        'RATE_LIMITED',
        'Too many new titles added in the last minute. Try again in a moment.',
      );
    }
  }

  /**
   * Re-install rooms read back from durable storage at boot (PROTOCOL.md § 8).
   *
   * A restored room has no participants — sockets do not survive a restart — so
   * it lands directly in the idle state a party is in between its last viewer
   * leaving and its removal, and expires on the same schedule. Rooms that were
   * already past that window while the relay was down are dropped rather than
   * resurrected. Returns the number of rooms taken.
   */
  restore(rooms: PersistedRoom[]): number {
    const now = this.deps.clock();
    let taken = 0;
    for (const persisted of rooms) {
      if (this.deps.store.get(persisted.state.roomId) !== undefined) continue;
      // A clock that moved backwards must not park a room forever; treat any
      // future timestamp as "empty as of now".
      const emptySince = Math.min(persisted.emptySince ?? now, now);
      if (now - emptySince >= this.deps.emptyRoomTtlMs) continue;
      const room: Room = {
        // Empty, and therefore a lobby — `startedAt` is decided here rather than trusted, because
        // every document written before that rule existed carries a latched value and a restart
        // would otherwise resurrect a room nobody could start together. Same reasoning as
        // `enterIdle`, which is the state this room is being restored directly into.
        state: { ...persisted.state, participants: [], startedAt: null },
        waitingFor: new Set(),
        bufferingTimers: new Map(),
        stallTimers: new Map(),
        graceTimers: new Map(),
        emptySince,
        idleTimer: null,
        lastHostName: persisted.lastHostName,
        // Sockets do not survive a restart, so every restored room is hostless and every one of
        // them arms a claim. `null` for a document written before the field existed: those rooms
        // keep the old behaviour of handing the chair to whoever rejoins first.
        hostClaimUserId: persisted.lastHostUserId,
        presenceDirty: false,
        presenceTimer: null,
        presenceCauseParticipantId: null,
        presenceTimerDueAt: 0,
        stateFlushAt: new Map(),
        // The creator is not persisted; the host it was saved with is the nearest thing.
        ownerUserId: persisted.lastHostUserId,
        holdArmedAt: new Map(),
        deferredHolds: new Set(),
        holdTimer: null,
        holdTimerDueAt: 0,
        endTimer: null,
        endTimerDueAt: 0,
        itemRuntime: null,
      };
      this.deps.store.set(room);
      this.armIdleTimer(room, this.deps.emptyRoomTtlMs - (now - emptySince));
      taken += 1;
    }
    if (taken > 0) this.deps.broadcastLobby();
    return taken;
  }

  joinRoom(info: ParticipantInfo, roomId: string): RoomState {
    if (this.memberships.has(info.participantId)) {
      throw new DomainError('ALREADY_IN_ROOM', 'This session already participates in a room');
    }
    const room = this.deps.store.get(roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', `Room ${roomId} does not exist`);

    // The maturity rule, and FIRST of the refusals on purpose: it is the one that can never
    // be satisfied by doing something else, and every check below it has a side
    // effect or a race the refused joiner should not pay for — releasing their
    // own other device's seat, reviving an idle room, cancelling its removal.
    this.assertRoomWatchableBy(room, info.userId);

    // **One device per room, per account.** Run before the capacity check on purpose: when both
    // refusals are true the viewer can only act on this one, and when the seat below is released
    // the room may not be full any more.
    const takenOver = this.releaseSeatHeldByAnotherDevice(room, info.userId);
    // Releasing the last seat empties the room, and an operator who has set `EMPTY_ROOM_TTL_MS` to
    // 0 has asked for an emptied room to be removed at once rather than held. Say so rather than
    // seating somebody in a room the store no longer has: the party was this account's dead
    // session alone, and it was going to end the moment that grace expired regardless.
    if (this.deps.store.get(roomId) === undefined) {
      throw new DomainError('ROOM_NOT_FOUND', `Room ${roomId} does not exist`);
    }

    // A seat taken over is still in the roster until the mutation below swaps it out.
    const seated = room.state.participants.length - (takenOver === null ? 0 : 1);
    if (seated >= this.deps.maxParticipants) {
      throw new DomainError('ROOM_FULL', 'The room has reached its participant limit');
    }
    // Joining an idle room revives it: cancel the removal timer before the
    // mutation, so a room can never be dropped between the two.
    const wasIdle = room.state.participants.length === 0;
    if (wasIdle) this.clearIdle(room);
    // The chair the room has been holding for its last host, if this is them. Read before the
    // mutation so the idle and revived cases decide it the same way.
    const reclaimsHost = room.hostClaimUserId !== null && room.hostClaimUserId === info.userId;
    this.rememberSeat(info, roomId);
    this.mutate(
      room,
      // Still `participant.joined` even when the chair moves with it. The join is the event —
      // clients announce arrivals from this cause (`WatchPage.tsx`) and the new host is plainly
      // visible in the snapshot that carries it, so trading the arrival for `host.changed` would
      // silence a notice to report something nobody has to be told twice.
      //
      // That includes a dropped host taking its own seat back from a new session: the
      // chair stays with the person, so nothing about it changed that anybody has to be told, and
      // every client reads a join whose account held the swapped-out seat as a silent return.
      // `host.changed` here drew "Became host" for somebody who never stopped being it.
      { type: 'participant.joined', participantId: info.participantId },
      (now) => {
        if (takenOver !== null) this.dropSeatFromState(room, takenOver, { keepChair: true });
        room.state.participants.push({
          participantId: info.participantId,
          userId: info.userId,
          userName: info.userName,
          // Nobody is left to hand the room over, so whoever comes back first
          // hosts it. Every other join is a guest, as always.
          role: wasIdle || takenOver?.wasHost === true ? 'host' : 'guest',
          connection: 'connected',
          playerState: 'idle',
          lastPositionMs: null,
          lastReportAt: null,
          joinedAt: now,
        });
        // The chair follows its person back into the room: the seat just swapped out held
        // it, so the session that took the seat over holds it in this same revision.
        if (wasIdle || takenOver?.wasHost === true) {
          room.state.hostParticipantId = info.participantId;
          room.lastHostName = info.userName;
        }
        if (reclaimsHost) {
          // `setHost` rather than the two lines above: somebody else may be sitting in the chair,
          // and their `role` has to come back down to `guest` in the same revision.
          this.setHost(room, info.participantId);
          room.lastHostName = info.userName;
          room.hostClaimUserId = null;
        }
      },
      { except: info.participantId },
    );
    this.deps.broadcastLobby();
    return this.snapshot(room);
  }

  /**
   * Make room for a second device of `userId`, or refuse it.
   *
   * The rule the operator asked for: **one device per room, per account.** Two rooms from two
   * devices is fine and stays fine — this looks only inside the room being joined.
   *
   * The exception is the whole design. Refuse only while the other session still has a socket; if
   * it is inside its reconnect grace — a television that lost wi-fi — release its membership and
   * let the new device take the seat over. The refusal tells somebody to go and leave the party on
   * a named device, and that instruction is impossible to obey when the device it names is
   * offline. See `../liveness.ts` for the judgement, which the per-user session cap makes too.
   */
  private releaseSeatHeldByAnotherDevice(room: Room, userId: string): ReleasedSeat | null {
    const held = room.state.participants.find((p) => p.userId === userId);
    if (held === undefined) return null;
    if (participantIsLive(held)) {
      throw new DomainError(
        'JOINED_ON_ANOTHER_DEVICE',
        joinedOnAnotherDeviceMessage(this.deviceNames.get(held.participantId) ?? null),
      );
    }
    // Not a kick: it is the same person taking their own seat back on a device that works — a new
    // tab, a relaunched app, inside the minute the seat was held for them. The full removal runs,
    // so the grace timer is cancelled; a room this empties idles exactly as it would have when the
    // grace ran out by itself (nobody is left to tell), and its chair claim seats them as host.
    if (room.state.participants.length === 1) {
      this.removeParticipant(room, held.participantId);
      return null;
    }
    // Anyone else still in the room hears the release and the arrival as ONE revision, carried by
    // the join (grace-leave, 2026-09-25): a departure and an arrival of the same person a
    // millisecond apart told every other seat "Ana left" and "Ana joined" about somebody who never
    // went, and the clients read the swap in one snapshot as a return and draw nothing. A chair the
    // seat held goes with it to the new session.
    return this.releaseSeat(room, held.participantId);
  }

  /** Record a session's seat and, if it named itself, what to call it, and its ceiling if any. */
  private rememberSeat(info: ParticipantInfo, roomId: string): void {
    this.memberships.set(info.participantId, roomId);
    const deviceName = displayableDeviceName(info.deviceName);
    if (deviceName !== null) this.deviceNames.set(info.participantId, deviceName);
    if (info.maturityCeiling != null) this.ceilings.set(info.participantId, info.maturityCeiling);
  }

  /** Release a session's seat and everything held alongside it. */
  private forgetSeat(participantId: string): void {
    this.memberships.delete(participantId);
    this.deviceNames.delete(participantId);
    this.ceilings.delete(participantId);
  }

  /**
   * The lowest Jellyfin ceiling among the room's seated participants, or null when none of them
   * has one.
   *
   * Every seat counts, `reconnecting` ones included, on the same footing `assertAddableBy` puts
   * them: the seat is genuinely reserved for `reconnectGraceMs`, the person is coming back to it,
   * and the level that constrains what the room may add is theirs until the relay gives the seat
   * up — at which point `removeParticipant` re-derives the pair without them.
   */
  private lowestCeiling(room: Room): number | null {
    let lowest: number | null = null;
    for (const p of room.state.participants) {
      const ceiling = this.ceilings.get(p.participantId);
      if (ceiling === undefined) continue;
      if (lowest === null || ceiling < lowest) lowest = ceiling;
    }
    return lowest;
  }

  leaveRoom(participantId: string, roomId: string): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.removeParticipant(room, participantId);
  }

  closeRoom(participantId: string, roomId: string): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertHost(room, participantId);
    this.closeRoomInternal(room, 'host-closed');
  }

  /**
   * Broadcast `room.closed {server-shutdown}` to every room and drop them all.
   *
   * Only used when the relay is going down and could NOT persist its rooms: a
   * party that will not come back has to be reported as over, rather than
   * leaving every client reconnecting into a room that no longer exists. The
   * normal shutdown path saves the rooms instead and says nothing, so clients
   * reconnect and rejoin where they left off.
   */
  closeAllRooms(): void {
    for (const room of [...this.deps.store.all()]) {
      this.closeRoomInternal(room, 'server-shutdown');
    }
  }

  /** Re-push the open-party roster; used when a change outside a room affects it. */
  publishLobby(): void {
    this.deps.broadcastLobby();
  }

  /**
   * Re-derive the maturity rule's display pair for every live room, and broadcast **only**
   * the rooms whose pair actually moved.
   *
   * `refreshMaturity` already runs on every mutation and every returned
   * snapshot, which covers a room that is being *used*. What it does not cover
   * is the answers underneath it going stale: measured on a running
   * party, `summarize` skips an item whose rating entry has expired, nothing
   * re-warmed a live room's items, and the room reported `'G'` at revision 256
   * and `null` from revision 334 (168 s later) onward — in every broadcast and
   * in the persisted snapshot sixteen minutes after that. It came back only
   * because a relay restart made every client re-hello.
   *
   * The other half of that fix is the periodic refresh in `../server.ts`, which
   * keeps the answers fresh; this is what turns a re-warm back into the room's
   * stamp. It is called after every refresh, so the "did anything move" test is
   * load-bearing rather than an optimization:
   *
   *  - a room whose pair is unchanged is **not broadcast and not re-versioned**.
   *    `refreshMaturity` is deliberately outside the revision bump (see its own
   *    note), and versioning a room every few minutes because a cache was
   *    renewed would make `revision` mean something it does not.
   *  - a room whose pair moved **is** broadcast through `mutate`, which bumps
   *    `revision` — and it has to, because clients apply the monotonicity rule
   *    (PROTOCOL.md § 6.3) to pushes and would drop a re-broadcast that arrived
   *    at the revision they already hold. A push nobody applies is not a fix.
   *
   * The cause is `participant.updated` with no participant named: it is the
   * existing "here is the room again, nobody did anything" cause that
   * `flushPresence` already emits unsolicited on a timer, and every client
   * already treats it as a plain snapshot — the two that read a cause to
   * announce something require its `participantId`, which this does not carry.
   * Inventing a cause value would be additive on the wire and this work is not.
   */
  refreshRoomMaturity(): void {
    for (const room of [...this.deps.store.all()]) {
      // The same answer can have brought the playing item its runtime, which no
      // mutation would otherwise pick up until somebody pressed something.
      this.armEndOfItem(room);
      const playback = room.state.playback;
      const previousRating = playback.maturityRating;
      const previousUnrated = playback.containsUnrated;
      this.refreshMaturity(room);
      if (
        playback.maturityRating === previousRating &&
        playback.containsUnrated === previousUnrated
      ) {
        continue;
      }
      this.mutate(room, { type: 'participant.updated' }, () => undefined);
    }
  }

  /**
   * Release every timer the manager holds, leaving room state untouched. Used
   * at shutdown, where rooms are persisted rather than closed and their idle,
   * presence, buffering, and grace timers must not hold the process open.
   */
  stopTimers(): void {
    for (const room of this.deps.store.all()) {
      if (room.idleTimer !== null) {
        this.deps.clearTimer(room.idleTimer);
        room.idleTimer = null;
      }
      if (room.presenceTimer !== null) {
        this.deps.clearTimer(room.presenceTimer);
        room.presenceTimer = null;
      }
      for (const handle of room.bufferingTimers.values()) this.deps.clearTimer(handle);
      room.bufferingTimers.clear();
      this.clearStallClocks(room);
      for (const handle of room.graceTimers.values()) this.deps.clearTimer(handle);
      room.graceTimers.clear();
      this.clearDeferredHolds(room);
      this.clearEndOfItem(room);
    }
  }

  /**
   * Every room this relay holds, **with no viewer filter applied at all** — for
   * diagnostics and tests. Since the maturity rule the roster a session receives depends on
   * who that session is, so **never push this**: use `lobbyFor`. The name says
   * so because the only thing standing between the two is which method a future
   * caller reaches for.
   *
   * Every open party belongs to this relay's one configured Jellyfin namespace.
   * Idle parties (`participantCount: 0`) stay listed for their removal window,
   * because the lobby is how someone walks back into the party they just left —
   * or the one their relay restarted underneath.
   *
   * **Bounded by `MAX_LOBBY_GROUPS`, which is the same number the wire schema enforces.** This
   * used to emit one group per room in the store, unbounded, which is reachable rather than
   * theoretical: an emptied room is held for `EMPTY_ROOM_TTL_MS` (15 minutes by default) and one
   * afternoon of testing left 31 rooms standing without trying. An over-cap frame does not fail
   * uniformly — a Zod-validating client rejects the whole `lobby.state` and its party rail goes
   * dark, while `[LobbyGroup]` in Swift and `List<LobbyGroup>` in Kotlin enforce no maximum and
   * carry on — so the relay would be the single cause of two different behaviours.
   *
   * **What is dropped, when it must drop something.** Live rooms are emitted first and idle rooms
   * fill what is left, because an idle room is the one a viewer can afford to lose from the list:
   * nobody is in it and it is on a countdown to removal anyway. Among the idle ones the most
   * recently emptied survive — the party someone just walked out of is the one they walk back
   * into, and the oldest are nearest their expiry. All three clients already render the list
   * live-half-then-idle-half (`HomeView.partyRailGroups`, `TVPartyRail.make`, `PartyRail`), so a
   * truncating relay emitting in that same order and a re-sorting client cannot disagree about
   * where the boundary fell.
   *
   * Below the cap — which is every real relay — the store's own order is emitted untouched.
   */
  lobbyUnfiltered(): LobbyGroup[] {
    return this.groups([...this.deps.store.all()]);
  }

  /**
   * The lobby as one account may see it — **the only roster that may be sent to
   * a session**.
   *
   * A room is dropped when Jellyfin has told the relay that this account may not
   * see **any** of its media, current item or queue entry. Hiding on the current
   * item alone was rejected explicitly: _"a room whose current film is fine and
   * whose next entry is not would still be offered"_, and a room hidden today
   * would reappear the moment the queue advanced. Watchability is a property of
   * the whole queue.
   *
   * **A room whose items are not resolved yet is not listed yet**, and
   * this is what closes the advertisement window: measured, a new
   * party on a cold R-rated film was offered to a ceiling-7 account for 320 ms
   * and then withdrawn, and a join inside that window succeeded. The room now
   * appears once its items are known — the same ~170 ms later — instead of
   * appearing and being taken away.
   *
   * A room whose items Jellyfin **could not answer for** is still listed. That
   * is the deliberate direction, it is the one the maturity rule's fail-open paragraph is
   * about, and `../visibility.ts` keeps the two states apart so this line can
   * mean one of them. It is also why `RoomManager.joinRoom` guards independently
   * rather than trusting that a listed room is a joinable one.
   *
   * Filtering happens **before** the `MAX_LOBBY_GROUPS` truncation, so a viewer
   * gets a full-length roster of parties they can actually enter rather than a
   * short one padded with rooms that were dropped afterwards.
   */
  lobbyFor(viewerUserId: string): LobbyGroup[] {
    const rooms = [...this.deps.store.all()].filter((room) =>
      this.roomIsVisibleTo(room, viewerUserId),
    );
    return this.groups(rooms);
  }

  /** Every item id any room currently holds; what a warm has to cover. */
  itemIdsInRooms(): string[] {
    const ids = new Set<string>();
    for (const room of this.deps.store.all()) {
      for (const itemId of roomItemIds(room)) ids.add(itemId);
    }
    return [...ids];
  }

  /**
   * Order, cap and summarize a room list into wire groups.
   *
   * **No maturity level here.** The maturity rule puts the display pair on the
   * room snapshot (`refreshMaturity`), because the operator ruled it is not
   * shown on the open-room card and is shown inside the room. What this list
   * still does is the *filtering*, in `lobbyFor` above — that is the gate, and
   * it is unchanged.
   */
  private groups(rooms: Room[]): LobbyGroup[] {
    const capacity = this.deps.maxParticipants;
    const toGroup = (room: Room): LobbyGroup => {
      const state = room.state;
      const host = state.participants.find((p) => p.participantId === state.hostParticipantId);
      return {
        roomId: state.roomId,
        name: state.name,
        // An idle room has no host to name, and `hostName` may not be empty on
        // the wire (a rejected frame would drop the whole roster), so the last
        // host stands in until someone rejoins.
        hostName: host?.userName ?? room.lastHostName,
        participantCount: occupantCount(room),
        capacity,
        itemId: state.playback.itemId ?? null,
      };
    };

    if (rooms.length <= MAX_LOBBY_GROUPS) return rooms.map(toGroup);

    const now = this.deps.clock();
    const live = rooms.filter((room) => occupantCount(room) > 0);
    const idle = rooms
      .filter((room) => occupantCount(room) === 0)
      // Most recently emptied first. An unattended room has not emptied yet — its seats are still
      // reserved — so it is treated as having emptied just now: it is the freshest of the half and
      // the likeliest to come back, which makes it the last one to drop rather than the first.
      .sort((a, b) => (b.emptySince ?? now) - (a.emptySince ?? now));
    // Live rooms fill the cap first; if there are somehow more than `MAX_LOBBY_GROUPS` of those,
    // the slice takes them in store order and no idle room is listed at all.
    return [...live, ...idle].slice(0, MAX_LOBBY_GROUPS).map(toGroup);
  }

  /**
   * What this account's answers say about the whole room, in one word.
   *
   * `withheld` outranks `unresolved` deliberately: a refusal Jellyfin has
   * actually given is final and no retry will change it, so a room holding both
   * a withheld entry and an unresolved one is refused with the maturity rule's sentence
   * rather than told to try again. Saying "not yet" about a settled answer is
   * the same class of lie in the other direction.
   */
  private roomWatchabilityFor(room: Room, viewerUserId: string): RoomWatchability {
    let unresolved = false;
    for (const itemId of roomItemIds(room)) {
      const access = this.deps.visibility.access(viewerUserId, itemId);
      if (access === 'withheld') return 'withheld';
      if (access === 'unresolved') unresolved = true;
    }
    return unresolved ? 'unresolved' : 'watchable';
  }

  private roomIsVisibleTo(room: Room, viewerUserId: string): boolean {
    return this.roomWatchabilityFor(room, viewerUserId) === 'watchable';
  }

  /**
   * The maturity rule's join door. **Both doors are required, so a bug in one does not open
   * the other** — this is not a redundant re-check of `lobbyFor`, because a
   * `room.join` for a room that never appeared in a roster is still valid
   * (PROTOCOL.md § 8.1) and is how rejoin-by-id works.
   *
   * **An unresolved room refuses too, and refuses differently.** Measured: a room created on a cold
   * item was joinable by a ceiling-7
   * account for the 170–320 ms before its warm landed, and the seat that join
   * took was permanent, because nothing re-evaluates a room once somebody is in
   * it. So the door waits — with a **retryable** error and a sentence that says
   * the check has not finished, never the maturity rule's, which is a final statement about
   * this account and would be a lie here.
   */
  private assertRoomWatchableBy(room: Room, viewerUserId: string): void {
    const verdict = this.roomWatchabilityFor(room, viewerUserId);
    if (verdict === 'watchable') return;
    if (verdict === 'withheld') {
      throw new DomainError('FORBIDDEN', maturityJoinRefusalMessage());
    }
    this.deps.requestVisibility([viewerUserId], roomItemIds(room));
    throw new DomainError(VISIBILITY_PENDING_CODE, maturityJoinPendingMessage(), true);
  }

  /**
   * The maturity rule's add door: the room's media may never exceed any **seated**
   * participant's ceiling.
   *
   * Every participant counts, `reconnecting` ones included: the seat is
   * genuinely reserved for `reconnectGraceMs` and the person is coming back to
   * whatever the queue holds by then. Refusal, never eviction — the operator
   * chose that twice, on the grounds that _"it could become annoying force
   * stopping or removing media just because someone joined with lower maturity
   * level."_
   *
   * **A candidate nobody has an answer about waits, and this is the unresolved-state change's
   * larger
   * half.** Measured against the deployed relay: the first
   * `playback.setItem` or `queue.set` naming any item unresolved within the TTL
   * was allowed **every time**, with a ceiling-7 account seated — not a race,
   * because the add is itself what changes the item set that the following warm
   * resolves. The room then held over-ceiling media with that viewer in it
   * permanently. So an unresolved candidate is a retryable refusal, the door
   * asks for the answers it lacked, and the same press a second later is
   * decided.
   *
   * A definite `withheld` still wins: it is settled, and the maturity rule's sentence names
   * the person the host has to act on.
   */
  private assertAddableBy(room: Room, itemIds: string[]): void {
    const blocked: string[] = [];
    const pending: string[] = [];
    for (const participant of room.state.participants) {
      let excluded = false;
      let unresolved = false;
      for (const itemId of itemIds) {
        const access = this.deps.visibility.access(participant.userId, itemId);
        if (access === 'withheld') {
          excluded = true;
          break;
        }
        if (access === 'unresolved') unresolved = true;
      }
      if (excluded) {
        if (!blocked.includes(participant.userName)) blocked.push(participant.userName);
      } else if (unresolved && !pending.includes(participant.userId)) {
        pending.push(participant.userId);
      }
    }
    if (blocked.length > 0) {
      throw new DomainError('FORBIDDEN', maturityAddRefusalMessage(blocked));
    }
    if (pending.length === 0) return;
    this.deps.requestVisibility(pending, itemIds);
    throw new DomainError(VISIBILITY_PENDING_CODE, maturityAddPendingMessage(), true);
  }

  // -------------------------------------------------------------------------
  // Settings / host
  // -------------------------------------------------------------------------

  setSettings(participantId: string, roomId: string, settings: Partial<RoomSettings>): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertHost(room, participantId);
    this.mutate(room, { type: 'settings.changed', participantId }, () => {
      room.state.settings = { ...room.state.settings, ...settings };
      // Switching to `ignore` while frozen by buffering would otherwise leave
      // the room stuck in `waiting` (recovery reports no longer resume it).
      if (
        room.state.settings.bufferingPolicy === 'ignore' &&
        room.state.playback.state === 'waiting'
      ) {
        this.clearBufferingWait(room);
        room.state.playback.state = 'playing';
      } else {
        // Switching to pause-all mid-playback must pick up participants that
        // are already known to be buffering (their reports are edge-triggered).
        this.armBufferingHolds(room);
      }
    });
  }

  transferHost(participantId: string, roomId: string, toParticipantId: string): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertHost(room, participantId);
    const target = room.state.participants.find((p) => p.participantId === toParticipantId);
    if (!target) {
      throw new DomainError('INVALID_STATE', 'Target is not a participant of this room');
    }
    this.mutate(room, { type: 'host.changed', participantId }, () => {
      this.setHost(room, toParticipantId);
      room.lastHostName = target.userName;
      // A human has now decided who holds the chair. That outranks anything the room remembered
      // about who held it before, so the returning-host claim is spent here rather than waiting.
      room.hostClaimUserId = null;
    });
    this.deps.broadcastLobby();
  }

  // -------------------------------------------------------------------------
  // Playback commands (user intent)
  // -------------------------------------------------------------------------

  play(participantId: string, roomId: string, positionMs?: number): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertCanControl(room, participantId);
    this.requireItem(room);
    this.mutate(room, { type: 'playback.play', participantId }, () => {
      this.clearBufferingWait(room);
      const playback = room.state.playback;
      if (positionMs !== undefined) playback.positionMs = positionMs;
      playback.state = 'playing';
      // Buffering reports are edge-triggered: a participant that reported
      // buffering while the room was paused sends no new report when playback
      // starts, so the pause-all hold must be re-armed here or the room would
      // play on while a participant is known to be starved.
      this.armBufferingHolds(room);
    });
  }

  pause(participantId: string, roomId: string, positionMs?: number): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertCanControl(room, participantId);
    this.requireItem(room);
    this.mutate(room, { type: 'playback.pause', participantId }, () => {
      // Explicit user intent overrides a buffering hold.
      this.clearBufferingWait(room);
      const playback = room.state.playback;
      if (positionMs !== undefined) playback.positionMs = positionMs;
      playback.state = 'paused';
    });
  }

  seek(participantId: string, roomId: string, positionMs: number): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertCanControl(room, participantId);
    this.requireItem(room);
    this.mutate(room, { type: 'playback.seek', participantId }, () => {
      room.state.playback.positionMs = positionMs;
    });
  }

  /**
   * Changing the film republishes the lobby, where `play`/`pause`/`seek` and
   * position reports deliberately do not.
   *
   * Those are chatty and change nothing a `LobbyGroup` carries. This changes
   * two things it does: `itemId` — which was already going stale in every
   * roster until some unrelated event happened to republish — and, since the maturity rule,
   * whether the room is listed at all for a given account. **A room that has
   * just switched to media somebody may not watch has to leave their roster
   * now**, not whenever the next person joins something.
   */
  setItem(participantId: string, roomId: string, payload: SetItemPayload): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertCanControl(room, participantId);
    this.assertStepsThroughQueue(room, participantId, payload.itemId);
    this.chargeAdd(room, this.getParticipant(room, participantId).userId, [payload.itemId]);
    this.assertAddableBy(room, [payload.itemId]);
    this.mutate(room, { type: 'playback.setItem', participantId }, () => {
      this.clearBufferingWait(room);
      const playback = room.state.playback;
      playback.itemId = payload.itemId;
      playback.state = 'paused';
      playback.positionMs = payload.positionMs ?? 0;
      playback.queueIndex = payload.queueIndex ?? null;
      playback.rate = 1;
      // A different film has not begun. Without this the auto-open transition fired exactly once
      // per room's whole lifetime, so the second entry in a queue started for whoever pressed Start
      // and for nobody else. `mutate` re-latches this the moment the new film reaches `playing`.
      room.state.startedAt = null;
      // Readiness/positions reported for the previous item are meaningless for
      // the new one; readiness is only re-established by a fresh client.ready
      // or client.position report (PROTOCOL.md § 13.2).
      for (const p of room.state.participants) {
        p.playerState = 'loading';
        p.lastPositionMs = null;
      }
    });
    this.deps.broadcastLobby();
  }

  /**
   * Republishes the lobby for the same reason `setItem` does: the queue is part
   * of what the maturity rule hides on, and of the maturity summary a card displays.
   *
   * **Host-only, whatever `controlMode` says**. `controlMode` governs
   * starting and pausing; it does not decide what the room watches next. This
   * inherited `assertCanControl` from the playback commands until 2026-09-08,
   * so an "everyone" room let any guest replace the film — an overloaded
   * "control playback" that silently also meant "change the film" is a
   * surprise in the direction that costs a room its evening. It is the host's,
   * on the same footing as `setSettings`, `transferHost` and `close`.
   *
   * The host question is asked first because it is cheap and about the caller;
   * `assertAddableBy` below is about the room's occupants.
   */
  setQueue(participantId: string, roomId: string, payload: QueueSetPayload): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.assertHost(room, participantId);
    if (payload.queueIndex != null && payload.queueIndex >= payload.items.length) {
      throw new DomainError('INVALID_STATE', 'queueIndex is out of range for the provided queue');
    }
    this.chargeAdd(
      room,
      this.getParticipant(room, participantId).userId,
      payload.items.map((item) => item.itemId),
    );
    // `queue.set` is a full write, so the candidate set is the whole new queue
    // rather than a diff against the old one — an entry that survives the write
    // is still an entry the room will play.
    this.assertAddableBy(
      room,
      payload.items.map((item) => item.itemId),
    );
    this.mutate(room, { type: 'queue.set', participantId }, () => {
      const playback = room.state.playback;
      playback.queue = payload.items.map((item) => ({ itemId: item.itemId }));
      if (payload.queueIndex !== undefined) {
        playback.queueIndex = payload.queueIndex;
      } else if (playback.queueIndex !== null && playback.queueIndex >= playback.queue.length) {
        playback.queueIndex = null;
      }
    });
    this.deps.broadcastLobby();
  }

  // -------------------------------------------------------------------------
  // Client status reports (never user commands)
  // -------------------------------------------------------------------------

  /**
   * Record one client's position/player state (PROTOCOL.md § 11).
   *
   * Presence is applied immediately but broadcast on a coalescing timer: every
   * participant reports on the same cadence, so broadcasting each report as its
   * own `room.state` sent the full snapshot N² times per interval for an
   * N-person room, all of it describing the same unchanged timeline. One
   * snapshot per interval carries every pending report at once. Reports that do
   * change the shared timeline — buffering, readiness, commands — are never
   * coalesced and still broadcast on arrival.
   *
   * Nor is a report that changes the seat's `playerState` (`loading` → `ready`,
   * `ready` → `playing`, into or out of `buffering`): that is what a host is
   * watching the roster for before Start, and a window of up to
   * `positionReportIntervalMs` put it two seconds behind the player. It goes
   * out on arrival, at most once per `STATE_FLUSH_MIN_INTERVAL_MS` per seat;
   * a seat flapping faster than that has the rest deferred to the end of its
   * window, so it cannot flood the room.
   */
  reportPosition(participantId: string, roomId: string, payload: ClientPositionPayload): void {
    const room = this.requireRoomMember(roomId, participantId);
    const participant = this.getParticipant(room, participantId);
    // A seat the room is waiting on that now reports anything but `buffering` has recovered, and
    // this report is the release (PROTOCOL.md § 13.1). `play()` arms holds from the
    // *recorded* state, which a position report alone can set, and every client debounces its
    // `buffering: true` edge — so a hold can stand on a seat that never sent the edge and so has
    // no `buffering: false` to send. It then froze the room for the whole `bufferingMaxWaitMs`.
    // Every client derives this state and its edge from the same local player state, so this
    // is never ahead of a `buffering: false` the seat would have sent.
    if (payload.playerState !== 'buffering' && room.waitingFor.delete(participantId)) {
      this.clearBufferingTimer(room, participantId);
      const playback = room.state.playback;
      const resumes = room.waitingFor.size === 0 && playback.state === 'waiting';
      this.mutate(
        room,
        resumes
          ? { type: 'buffering.resumed', participantId }
          : { type: 'participant.updated', participantId },
        (now) => {
          participant.playerState = payload.playerState;
          participant.lastPositionMs = payload.positionMs;
          participant.lastReportAt = now;
          if (resumes) playback.state = 'playing';
        },
      );
      return;
    }
    const changed = participant.playerState !== payload.playerState;
    participant.playerState = payload.playerState;
    participant.lastPositionMs = payload.positionMs;
    participant.lastReportAt = this.deps.clock();
    // Before the flush, which may be deferred: the stall clock reads the recorded state, not the
    // broadcast one, so a stall that only ever reaches the relay as presence still counts.
    this.syncStallClocks(room);
    if (changed) this.flushStateChange(room, participantId);
    else this.schedulePresenceFlush(room, participantId);
  }

  /**
   * A seat's buffering edge (PROTOCOL.md § 13.1).
   *
   * **Bounded per seat, like a position report's state change** (security review M2). This used to
   * broadcast a full snapshot on every report, both edges, and it is not host-gated: a guest
   * flipping `true`/`false` at the command rate sent twenty snapshots a second to every seat. Now
   * each kind of edge goes out on arrival at most once per `STATE_FLUSH_MIN_INTERVAL_MS` per seat:
   *
   *  - a report that changes only the seat's `playerState` shares `flushStateChange`'s window with
   *    `client.position` and `client.ready`, and a flip inside it is carried by the window's end;
   *  - a report that **freezes** a pause-all room is the timeline itself, so it is never merely
   *    coalesced — but a seat that armed a hold inside its window waits for the window's end,
   *    and is held then if its last word is still `buffering` (`fireDeferredHolds`);
   *  - the release is immediate, and there can be no more releases than holds.
   *
   * A genuine stall is not delayed: its first `true` arms at once. Only a seat that stalls again
   * within half a second of its last hold waits, and for at most that half second.
   */
  reportBuffering(participantId: string, roomId: string, payload: ClientBufferingPayload): void {
    const room = this.requireRoomMember(roomId, participantId);
    const participant = this.getParticipant(room, participantId);
    const playback = room.state.playback;
    const pauseAll = room.state.settings.bufferingPolicy === 'pause-all';
    const now = this.deps.clock();
    const before = participant.playerState;
    const record = (playerState: Participant['playerState']): void => {
      participant.playerState = playerState;
      if (payload.positionMs !== undefined) participant.lastPositionMs = payload.positionMs;
      participant.lastReportAt = now;
    };

    if (payload.buffering) {
      const holds = pauseAll && (playback.state === 'playing' || playback.state === 'waiting');
      if (holds && !room.waitingFor.has(participantId)) {
        const armedAt = room.holdArmedAt.get(participantId);
        if (armedAt === undefined || now - armedAt >= STATE_FLUSH_MIN_INTERVAL_MS) {
          room.holdArmedAt.set(participantId, now);
          room.deferredHolds.delete(participantId);
          room.waitingFor.add(participantId);
          this.startBufferingTimer(room, participantId);
          this.mutate(room, { type: 'buffering.waiting', participantId }, () => {
            record('buffering');
            playback.state = 'waiting';
          });
          return;
        }
        room.deferredHolds.add(participantId);
        this.scheduleDeferredHolds(room, armedAt + STATE_FLUSH_MIN_INTERVAL_MS);
      }
      record('buffering');
      this.syncStallClocks(room);
      if (before !== 'buffering') this.flushStateChange(room, participantId);
      else this.schedulePresenceFlush(room, participantId);
      return;
    }

    room.deferredHolds.delete(participantId);
    const wasWaitedOn = room.waitingFor.delete(participantId);
    this.clearBufferingTimer(room, participantId);
    const resumes = wasWaitedOn && room.waitingFor.size === 0 && playback.state === 'waiting';
    const recovered = (resuming: boolean): Participant['playerState'] =>
      before === 'buffering'
        ? playback.state === 'playing' || resuming
          ? 'playing'
          : 'paused'
        : before;
    if (resumes) {
      this.mutate(room, { type: 'buffering.resumed', participantId }, () => {
        record(recovered(true));
        playback.state = 'playing';
      });
      return;
    }
    record(recovered(false));
    this.syncStallClocks(room);
    if (wasWaitedOn || participant.playerState !== before) {
      this.flushStateChange(room, participantId);
    } else {
      this.schedulePresenceFlush(room, participantId);
    }
  }

  /** A seat's readiness (PROTOCOL.md § 13.2), on the same per-seat window as any state change. */
  reportReady(participantId: string, roomId: string, itemId: string): void {
    const room = this.requireRoomMember(roomId, participantId);
    // Stale readiness (item changed since the client started loading): ack, no effect.
    if (room.state.playback.itemId !== itemId) return;
    const participant = this.getParticipant(room, participantId);
    const changed = participant.playerState !== 'ready';
    participant.playerState = 'ready';
    participant.lastReportAt = this.deps.clock();
    if (changed) this.flushStateChange(room, participantId);
    else this.schedulePresenceFlush(room, participantId);
  }

  /** Arm `holdTimer` for `dueAt`, unless it already fires sooner. */
  private scheduleDeferredHolds(room: Room, dueAt: number): void {
    if (room.holdTimer !== null) {
      if (room.holdTimerDueAt <= dueAt) return;
      this.deps.clearTimer(room.holdTimer);
    }
    room.holdTimerDueAt = dueAt;
    room.holdTimer = this.deps.setTimer(
      () => {
        room.holdTimer = null;
        this.fireDeferredHolds(room);
      },
      Math.max(0, dueAt - this.deps.clock()),
    );
  }

  /**
   * The end of a seat's hold window: hold the room for every deferred seat whose last word is
   * still `buffering`, exactly as the report would have on arrival, in one snapshot.
   */
  private fireDeferredHolds(room: Room): void {
    const now = this.deps.clock();
    const due: string[] = [];
    let nextDueAt: number | null = null;
    for (const participantId of room.deferredHolds) {
      const dueAt = (room.holdArmedAt.get(participantId) ?? now) + STATE_FLUSH_MIN_INTERVAL_MS;
      if (dueAt <= now) due.push(participantId);
      else nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
    }
    for (const participantId of due) room.deferredHolds.delete(participantId);
    if (nextDueAt !== null) this.scheduleDeferredHolds(room, nextDueAt);

    const playback = room.state.playback;
    if (room.state.settings.bufferingPolicy !== 'pause-all') return;
    if (playback.state !== 'playing' && playback.state !== 'waiting') return;
    const holding = due.filter((participantId) => {
      const p = room.state.participants.find((x) => x.participantId === participantId);
      return (
        p !== undefined &&
        p.connection === 'connected' &&
        p.playerState === 'buffering' &&
        !room.waitingFor.has(participantId)
      );
    });
    const first = holding[0];
    if (first === undefined) return;
    for (const participantId of holding) {
      room.holdArmedAt.set(participantId, now);
      room.waitingFor.add(participantId);
      this.startBufferingTimer(room, participantId);
    }
    this.mutate(room, { type: 'buffering.waiting', participantId: first }, () => {
      playback.state = 'waiting';
    });
  }

  private clearDeferredHolds(room: Room): void {
    if (room.holdTimer !== null) {
      this.deps.clearTimer(room.holdTimer);
      room.holdTimer = null;
    }
    room.deferredHolds.clear();
  }

  /**
   * The room as `participantId` would be sent it now, or null when it is not in that room — for
   * answering a replayed `room.create`/`room.join` id (`../router.ts`, security review L9).
   */
  memberSnapshot(roomId: string, participantId: string): RoomState | null {
    const room = this.deps.store.get(roomId);
    if (room === undefined || this.memberships.get(participantId) !== roomId) return null;
    return this.snapshot(room);
  }

  requestState(participantId: string, roomId: string, replyTo?: string): void {
    const room = this.requireRoomMember(roomId, participantId);
    this.deps.sendTo(
      participantId,
      createServerMessage(
        'room.state',
        { room: this.snapshot(room), cause: { type: 'state.request', participantId } },
        { roomId, replyTo, sentAt: this.deps.clock() },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  /** Socket dropped: mark reconnecting and start the removal grace timer. */
  handleDisconnect(participantId: string): void {
    const room = this.roomOf(participantId);
    if (!room) return;
    const participant = room.state.participants.find((p) => p.participantId === participantId);
    if (!participant || participant.connection === 'reconnecting') return;

    room.deferredHolds.delete(participantId);
    const wasWaitedOn = room.waitingFor.delete(participantId);
    this.clearBufferingTimer(room, participantId);
    const resumes =
      wasWaitedOn && room.waitingFor.size === 0 && room.state.playback.state === 'waiting';
    this.mutate(room, { type: 'participant.updated', participantId }, () => {
      participant.connection = 'reconnecting';
      if (resumes) room.state.playback.state = 'playing';
    });

    const handle = this.deps.setTimer(() => {
      room.graceTimers.delete(participantId);
      const p = room.state.participants.find((x) => x.participantId === participantId);
      if (p && p.connection === 'reconnecting') this.removeParticipant(room, participantId);
    }, this.deps.syncConfig.reconnectGraceMs);
    room.graceTimers.set(participantId, handle);

    // The room just stopped being watched, so the lobby now says something different about it.
    // `mutate` above broadcast the room's own state but deliberately does not republish the lobby
    // — presence traffic would make that push chatty — and every *other* disconnect leaves the
    // lobby's answer unchanged. Only this one, the drop that takes the last watcher, does; without
    // it the corrected count would sit here unseen until the grace timer removed the participants
    // a minute later, which is the whole defect.
    if (occupantCount(room) === 0) this.deps.broadcastLobby();
  }

  /** Session resumed: cancel the grace timer and mark connected again. */
  handleResume(participantId: string): RoomState | null {
    const roomId = this.memberships.get(participantId);
    if (roomId === undefined) return null;
    const room = this.deps.store.get(roomId);
    if (!room) {
      this.forgetSeat(participantId);
      return null;
    }
    const participant = room.state.participants.find((p) => p.participantId === participantId);
    if (!participant) return null;
    if (participant.connection === 'reconnecting') {
      // Read before the transition: if nobody was watching and now somebody is, the lobby has to
      // be told. Every later return into an already-attended room changes nothing it shows.
      const wasUnattended = occupantCount(room) === 0;
      const handle = room.graceTimers.get(participantId);
      if (handle !== undefined) {
        this.deps.clearTimer(handle);
        room.graceTimers.delete(participantId);
      }
      // **Everybody except the one resuming**, because that socket has not been
      // welcomed yet. `connection.ts` attaches it, calls this, and only then
      // sends `session.welcome` — so including the resumer writes a `room.state`
      // ahead of the frame that establishes the session, which PROTOCOL.md § 7
      // forbids and which no client can interpret: it has no session, no
      // `syncConfig` and no server capabilities to read the snapshot against.
      //
      // A client that applies it anyway takes the room as an ordinary push, and
      // an iOS relaunch did exactly that — it opened the room's screen, then the
      // welcome that followed gave the seat up underneath it and left "The party
      // ended" on screen over a party that was still running.
      //
      // The resumer loses nothing: this method's own return value is the same
      // snapshot, and it travels inside the welcome.
      this.mutate(
        room,
        { type: 'participant.updated', participantId },
        () => {
          participant.connection = 'connected';
        },
        { except: participantId },
      );
      if (wasUnattended) this.deps.broadcastLobby();
    }
    return this.snapshot(room);
  }

  /** Session gone for good: remove its participant immediately (no grace). */
  destroySession(participantId: string): void {
    const room = this.roomOf(participantId);
    if (!room) return;
    this.removeParticipant(room, participantId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private roomOf(participantId: string): Room | undefined {
    const roomId = this.memberships.get(participantId);
    if (roomId === undefined) return undefined;
    const room = this.deps.store.get(roomId);
    if (!room) this.forgetSeat(participantId);
    return room;
  }

  private requireRoomMember(roomId: string, participantId: string): Room {
    const room = this.deps.store.get(roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', `Room ${roomId} does not exist`);
    if (this.memberships.get(participantId) !== roomId) {
      throw new DomainError('NOT_IN_ROOM', 'This session is not a participant of the room');
    }
    return room;
  }

  private getParticipant(room: Room, participantId: string): Participant {
    const participant = room.state.participants.find((p) => p.participantId === participantId);
    if (!participant) throw new DomainError('INTERNAL', 'Participant record missing');
    return participant;
  }

  private assertHost(room: Room, participantId: string): void {
    if (room.state.hostParticipantId !== participantId) {
      throw new DomainError('FORBIDDEN', 'Only the host may perform this operation');
    }
  }

  private assertCanControl(room: Room, participantId: string): void {
    if (
      room.state.settings.controlMode === 'host-only' &&
      room.state.hostParticipantId !== participantId
    ) {
      throw new DomainError('FORBIDDEN', 'Playback control is restricted to the host');
    }
  }

  /**
   * The queue-step rule's door: a non-host may **step** through the queue and may not
   * **jump** outside it.
   *
   * `setQueue` is host-only and this is not, deliberately: pressing
   * Next is a control three clients draw for a guest, documented in as many
   * words in the Android TV player. But until 2026-09-08 the `itemId` was
   * never read against the room's own queue, so `controlMode: 'everyone'`
   * quietly also bought *replace the film with anything on the server* — the
   * same surprise the host-only queue rule was opened about, arriving through the other door.
   * Next is by definition an entry the queue holds, so the shipped path is
   * exactly what survives.
   *
   * **An empty queue refuses everything, and that is the decision rather than
   * an oversight.** A room created with an initial item has no queue, which is
   * the commonest shape a party takes; the carve-out that would keep a guest's
   * Next alive there reads "empty queue, allow anything" and re-opens the hole
   * for precisely those rooms. A room with no queue is one film its host
   * chose, and it stays the host's.
   *
   * **Membership, not the index.** `setQueue` range-checks its `queueIndex`
   * because it is writing the list; this reads one, and a client whose index
   * has gone stale under a concurrent edit is still asking for a film the room
   * holds. What a `null` index costs is the queue-index rule's, and is not repaired here.
   *
   * **Asked after `assertCanControl` on purpose.** In a `host-only` room the
   * guest must go on seeing the control-mode refusal they have always seen;
   * this one is about the room's queue, and only has anything to say where
   * control was granted in the first place.
   */
  private assertStepsThroughQueue(room: Room, participantId: string, itemId: string): void {
    if (room.state.hostParticipantId === participantId) return;
    if (room.state.playback.queue.some((entry) => entry.itemId === itemId)) return;
    throw new DomainError(
      'INVALID_STATE',
      'Only the host may play something the queue does not hold',
    );
  }

  private requireItem(room: Room): void {
    if (room.state.playback.itemId === null) {
      throw new DomainError('INVALID_STATE', 'No media item is selected');
    }
  }

  private snapshot(room: Room): RoomState {
    this.refreshMaturity(room);
    return structuredClone(room.state);
  }

  /**
   * Materialize the maturity rule's display-only pair into the live playback state.
   *
   * **Where the summary is computed, and why it is not the lobby's job any
   * more.** The operator ruled the room's level is not drawn on the open-room
   * card and is drawn inside the room, so the fact has to reach a client that
   * holds a `RoomState` — which means every `room.state` broadcast and both ack
   * snapshots (`room.create`, `room.join`). Calling it from `mutate` and
   * `snapshot` covers all of them and nothing else: every broadcast in this
   * class goes through `mutate`, and every returned snapshot through
   * `snapshot`.
   *
   * **It is a fact about the roster as well as the media**: the level is the lowest ceiling seated,
   * when any seat has one,
   * so it moves on join, leave, grace expiry and host transfer exactly as it
   * moves on `setItem` and `queue.set` — all of which are mutations, and every
   * mutation runs this after `apply`. The lobby's renewal (`refreshRoomMaturity`)
   * compares before and after and broadcasts only a pair that moved.
   *
   * **It is derived state, so it never bumps `revision`.** Two clients that
   * disagree about a label because one warmed a rating first are not two
   * versions of the room; `revision` orders mutations, and this is not one. It
   * is written onto the live state rather than onto the clone so that the
   * frame `mutate` broadcasts — deliberately the live object, not a copy —
   * carries it too.
   *
   * **On the 2 000 ms cadence.** A live room re-broadcasts on every presence
   * flush (`positionReportIntervalMs`), so this runs about twice a second per
   * room. That is affordable *by construction* rather than by measurement:
   * `RoomManagerDeps.visibility` is `ItemVisibility`, the deliberately
   * synchronous half of `../visibility.ts`, whose `summarize` is a fold over an
   * in-memory `Map` — no I/O, no promise, and a cold entry contributes nothing
   * instead of triggering a fetch. Filling the cache is `warm`'s job and lives
   * on the other interface, which this class cannot even reach. Memoizing per
   * revision was considered and rejected: `mutate` bumps the revision on every
   * call, so it would save nothing there, and it would pin a stale label on a
   * quiet room until its next mutation — exactly the room whose rating has just
   * been warmed.
   */
  private refreshMaturity(room: Room): void {
    const summary = this.deps.visibility.summarize(roomItemIds(room), this.lowestCeiling(room));
    room.state.playback.maturityRating = summary.maturityRating;
    room.state.playback.containsUnrated = summary.containsUnrated;
  }

  /**
   * Apply one room mutation: materialize the timeline at `now`, run `apply`,
   * bump the revision by exactly 1, broadcast a full `room.state`.
   */
  private mutate(
    room: Room,
    cause: RoomStateCause,
    apply: (now: number) => void,
    opts?: { except?: string },
  ): void {
    const now = this.deps.clock();
    const playback = room.state.playback;
    playback.positionMs = expectedPositionMs(playback, now);
    playback.measuredAt = now;
    apply(now);
    // The party has begun, whatever caused it. Latched here rather than in
    // `play` because six mutations reach `playing` — the buffering timer and
    // the pause-all recovery paths among them — and a client reads this to
    // decide the party is past its lobby. `??=`, so every later resume after a
    // pause leaves the original moment alone.
    //
    // **`waiting` counts, and leaving it out was a party that could never
    // start.** `play()` sets `playing` and then calls `armBufferingHolds`,
    // which downgrades the very same mutation to `waiting` when any
    // participant's last report was `buffering` (§ 13.1) — buffering reports
    // are edge-triggered, so one recorded in the lobby is still on file when
    // Start is pressed. Latching on `playing` alone left `startedAt` null for a
    // room whose timeline was already live, so every client sat in the lobby of
    // a running party until the hold timed out. `waiting` is `playing` held for
    // a laggard; it is not a lobby.
    if (room.state.playback.state === 'playing' || room.state.playback.state === 'waiting') {
      room.state.startedAt ??= now;
    }
    // After `apply`, because the mutation may have been the one that changed the
    // room's media, and before the broadcast, because the broadcast carries the
    // live object. Derived, so it is deliberately outside the revision bump.
    this.refreshMaturity(room);
    room.state.revision += 1;
    // Any broadcast carries every participant record, so pending presence
    // reports ride along with it and need no second snapshot of their own.
    this.cancelPresenceFlush(room);
    this.deps.persist();
    this.deps.broadcast(
      room.state.roomId,
      createServerMessage(
        'room.state',
        // Live state, deliberately not a clone: `broadcast` serializes the
        // frame once, synchronously, before returning (see RoomManagerDeps), so
        // no recipient can observe a later mutation through it. Cloning here
        // deep-copied the whole room on every mutation, several times a second.
        { room: room.state, cause },
        { roomId: room.state.roomId, sentAt: now },
      ),
      opts,
    );
    // Every change to the timeline — play, pause, seek, a new item, a queue edit, a hold and its
    // release — is a mutation, so this is the one place the end of the item is re-derived.
    this.armEndOfItem(room);
    // And the one place every stall clock is: a pause, a new item, a disconnect, a resume, a
    // join or a departure each change whether one runs.
    this.syncStallClocks(room);
  }

  /**
   * The natural-end fix: arm, move or clear the timer that stops the room's clock at the end of its
   * item.
   *
   * The relay's timeline is a projection — `positionMs + (now − measuredAt) × rate` while
   * `playing` — and it used to project forever: measured, a party on a 24-minute episode with
   * nothing queued read 128 s past the runtime until the host chose something, and a seat joining
   * in that window would have loaded past the end of the media. So when the room is `playing` an
   * item whose runtime is known and **nothing is next** in the queue, the clock stops at the
   * runtime: `paused` at `positionMs = runtime`, until the host picks something.
   *
   * **With a next item this does nothing**: the host's client advances the room
   * with `playback.setItem`, and a relay that paused first would race that advance. An unknown
   * runtime also does nothing — no answer yet, none carried, `0` for live TV — and the room behaves
   * exactly as it always has. A timer, not a poll: it fires once at the projected end and is
   * re-derived after every mutation, and a presence flush that moves nothing leaves it alone.
   */
  private armEndOfItem(room: Room): void {
    const dueAt = this.endOfItemDueAt(room);
    if (dueAt === null) {
      this.clearEndOfItem(room);
      return;
    }
    // The projection is the same line before and after a mutation that did not move it, so a
    // presence flush lands here and keeps the timer it has.
    if (room.endTimer !== null && Math.abs(room.endTimerDueAt - dueAt) < 1) return;
    this.clearEndOfItem(room);
    room.endTimerDueAt = dueAt;
    room.endTimer = this.deps.setTimer(
      () => {
        room.endTimer = null;
        this.stopAtEndOfItem(room);
      },
      Math.max(0, dueAt - this.deps.clock()),
    );
  }

  private clearEndOfItem(room: Room): void {
    if (room.endTimer === null) return;
    this.deps.clearTimer(room.endTimer);
    room.endTimer = null;
  }

  /** When a `playing` room reaches the end of an item with nothing next, or null when it will not. */
  private endOfItemDueAt(room: Room): number | null {
    const playback = room.state.playback;
    if (playback.state !== 'playing' || playback.rate <= 0) return null;
    // `queueIndex` names what is playing, and `null` reads as "before the start" — the reading
    // every client's end-of-item stage makes, so the relay and the stage agree on "next".
    if (playback.queue[(playback.queueIndex ?? -1) + 1] !== undefined) return null;
    const runtimeMs = this.itemRuntimeMs(room);
    if (runtimeMs === null) return null;
    return playback.measuredAt + Math.max(0, runtimeMs - playback.positionMs) / playback.rate;
  }

  /**
   * The runtime of the item on the timeline: the visibility cache's answer when it has one, and
   * otherwise the one this room last learned for the same item, so an entry ageing out between
   * refreshes does not quietly un-arm a room's end.
   */
  private itemRuntimeMs(room: Room): number | null {
    const itemId = room.state.playback.itemId;
    if (itemId === null) return null;
    const known = this.deps.visibility.runtimeMs(itemId);
    if (known !== null) {
      room.itemRuntime = { itemId, runtimeMs: known };
      return known;
    }
    return room.itemRuntime?.itemId === itemId ? room.itemRuntime.runtimeMs : null;
  }

  /**
   * The timer's work: one `room.state`, `paused` at the runtime.
   *
   * **The cause is `playback.pause` naming nobody.** It is what happened to the timeline, and
   * every client's notice column draws nothing for a cause without a `participantId`
   * (`partyActivity.ts`, `PartyActivity.swift`, `PartyActivityNotices.kt`), so the end draws no
   * "<name> paused" anywhere. Not a new cause value, which would be a wire change.
   */
  private stopAtEndOfItem(room: Room): void {
    const dueAt = this.endOfItemDueAt(room);
    if (dueAt === null) return;
    if (dueAt > this.deps.clock()) {
      this.armEndOfItem(room);
      return;
    }
    const runtimeMs = this.itemRuntimeMs(room);
    if (runtimeMs === null) return;
    this.mutate(room, { type: 'playback.pause' }, () => {
      const playback = room.state.playback;
      playback.positionMs = runtimeMs;
      playback.state = 'paused';
    });
  }

  /**
   * Broadcast a seat's `playerState` change now, unless that seat already did
   * so within `STATE_FLUSH_MIN_INTERVAL_MS`: then the change waits for the end
   * of the seat's window (or an earlier pending flush), which carries it.
   */
  private flushStateChange(room: Room, participantId: string): void {
    const now = this.deps.clock();
    const last = room.stateFlushAt.get(participantId);
    if (last !== undefined && now - last < STATE_FLUSH_MIN_INTERVAL_MS) {
      this.schedulePresenceFlush(room, participantId, last + STATE_FLUSH_MIN_INTERVAL_MS - now);
      return;
    }
    room.stateFlushAt.set(participantId, now);
    room.presenceDirty = true;
    room.presenceCauseParticipantId = participantId;
    this.flushPresence(room);
  }

  private schedulePresenceFlush(
    room: Room,
    participantId: string,
    delayMs = this.deps.syncConfig.positionReportIntervalMs,
  ): void {
    room.presenceDirty = true;
    room.presenceCauseParticipantId = participantId;
    const dueAt = this.deps.clock() + delayMs;
    if (room.presenceTimer !== null) {
      if (room.presenceTimerDueAt <= dueAt) return;
      this.deps.clearTimer(room.presenceTimer);
    }
    room.presenceTimerDueAt = dueAt;
    room.presenceTimer = this.deps.setTimer(() => {
      room.presenceTimer = null;
      this.flushPresence(room);
    }, delayMs);
  }

  private flushPresence(room: Room): void {
    if (!room.presenceDirty) return;
    const participantId = room.presenceCauseParticipantId;
    room.presenceDirty = false;
    room.presenceCauseParticipantId = null;
    if (room.state.participants.length === 0) return;
    this.mutate(
      room,
      participantId !== null
        ? { type: 'participant.updated', participantId }
        : { type: 'participant.updated' },
      () => undefined,
    );
  }

  private cancelPresenceFlush(room: Room): void {
    if (room.presenceTimer !== null) {
      this.deps.clearTimer(room.presenceTimer);
      room.presenceTimer = null;
    }
    room.presenceDirty = false;
    room.presenceCauseParticipantId = null;
  }

  private setHost(room: Room, hostParticipantId: string): void {
    room.state.hostParticipantId = hostParticipantId;
    for (const p of room.state.participants) {
      p.role = p.participantId === hostParticipantId ? 'host' : 'guest';
    }
  }

  /**
   * Everything a seat holds outside the room's state — its timers, its membership, its place in
   * the hold — released, and what the state change that removes it needs to know. The seat itself
   * stays in `room.state.participants` until `dropSeatFromState` runs inside a mutation.
   */
  private releaseSeat(room: Room, participantId: string): ReleasedSeat {
    this.clearBufferingTimer(room, participantId);
    this.clearStallClock(room, participantId);
    const graceHandle = room.graceTimers.get(participantId);
    if (graceHandle !== undefined) {
      this.deps.clearTimer(graceHandle);
      room.graceTimers.delete(participantId);
    }
    this.forgetSeat(participantId);
    const wasWaitedOn = room.waitingFor.delete(participantId);
    if (room.presenceCauseParticipantId === participantId) {
      room.presenceCauseParticipantId = null;
    }
    room.stateFlushAt.delete(participantId);
    room.holdArmedAt.delete(participantId);
    room.deferredHolds.delete(participantId);
    return {
      participantId,
      wasHost: room.state.hostParticipantId === participantId,
      wasWaitedOn,
    };
  }

  /**
   * The state half of a removal, for a room that keeps somebody: the seat goes, the chair passes
   * on if it held it, and a hold only it kept resumes. Called inside `mutate`. `keepChair` is the
   * same-account takeover, whose caller seats the chair's new session itself.
   */
  private dropSeatFromState(
    room: Room,
    released: ReleasedSeat,
    { keepChair = false }: { keepChair?: boolean } = {},
  ): void {
    const remaining = room.state.participants.filter(
      (p) => p.participantId !== released.participantId,
    );
    room.state.participants = remaining;
    if (released.wasHost && !keepChair) {
      this.setHost(room, this.pickNewHost(remaining).participantId);
    }
    if (
      released.wasWaitedOn &&
      room.waitingFor.size === 0 &&
      room.state.playback.state === 'waiting'
    ) {
      room.state.playback.state = 'playing';
    }
  }

  private removeParticipant(room: Room, participantId: string, reason?: RoomRemovalReason): void {
    const released = this.releaseSeat(room, participantId);

    const remaining = room.state.participants.filter((p) => p.participantId !== participantId);
    if (remaining.length === 0) {
      // The last one out is always the host (the role transfers as people
      // leave), so their name is the one the idle party keeps in the lobby.
      const leaving = room.state.participants.find((p) => p.participantId === participantId);
      if (leaving !== undefined) {
        room.lastHostName = leaving.userName;
        // The room has no host again, so arm the claim that gives the chair back to this account
        // if it is the one that walks in first — or the one that walks in second, behind whichever
        // app happened to reconnect fastest. See `Room.hostClaimUserId`.
        room.hostClaimUserId = leaving.userId;
      }
      room.state.participants = remaining;
      this.enterIdle(room);
      return;
    }

    this.mutate(
      room,
      {
        type: released.wasHost ? 'host.changed' : 'participant.left',
        participantId,
        // Only a removal says why; a departure the seat chose carries no reason at all.
        ...(reason !== undefined ? { reason } : {}),
      },
      () => this.dropSeatFromState(room, released),
    );
    // The room survived: participantCount (and possibly the host) changed.
    // The empty-room branch above delegates to closeRoomInternal, which
    // publishes there, so this only fires when the room is still open.
    this.deps.broadcastLobby();
  }

  /**
   * Who takes the chair when its host goes — a deliberate `room.leave` or the reconnect grace
   * running out, one rule for both (§ 13.3). The earliest-joined of the first pool that
   * has anybody in it:
   *
   *  1. connected seats that are watching — `playing`, `paused` or `buffering`;
   *  2. connected seats that are `ready`;
   *  3. connected seats;
   *  4. every seat.
   *
   * The operator, 2026-09-25: _"the earliest joined seat should take the host role"_, among the
   * seats actually watching, so a seat that joined early and never started the film no longer
   * takes the chair from people in the middle of it.
   */
  private pickNewHost(participants: Participant[]): Participant {
    const connected = participants.filter((p) => p.connection === 'connected');
    const pools = [
      connected.filter((p) => WATCHING_STATES.has(p.playerState)),
      connected.filter((p) => p.playerState === 'ready'),
      connected,
      participants,
    ];
    const candidates = pools.find((pool) => pool.length > 0) ?? participants;
    return candidates.reduce((best, p) => (p.joinedAt < best.joinedAt ? p : best));
  }

  /**
   * The room lost its last participant: freeze it and hold it for
   * `emptyRoomTtlMs` instead of destroying it. Nothing is broadcast — there is
   * nobody in the room to tell — but the lobby is republished, because an idle
   * party is still listed and still joinable, and rejoining it is the whole
   * point of the window.
   */
  private enterIdle(room: Room): void {
    this.cancelPresenceFlush(room);
    this.clearDeferredHolds(room);
    this.clearEndOfItem(room);
    for (const handle of room.bufferingTimers.values()) this.deps.clearTimer(handle);
    room.bufferingTimers.clear();
    this.clearStallClocks(room);
    room.waitingFor.clear();

    const now = this.deps.clock();
    const playback = room.state.playback;
    // An unattended room must not keep playing: a returning participant should
    // find the party where they left it, not however far the clock ran.
    playback.positionMs = expectedPositionMs(playback, now);
    playback.measuredAt = now;
    if (playback.state === 'playing' || playback.state === 'waiting') playback.state = 'paused';
    // **A room with nobody in it is a lobby again.** `startedAt` is a one-way latch within a
    // party's life — it must survive pause, seek-to-zero and resume, or a client reading it would
    // throw everybody back to the lobby at the first pause — but emptying ends that life. There is
    // nobody left to be mid-film, and whoever walks back in is starting rather than arriving late.
    //
    // Leaving it set made a party impossible to start a second time. Clients read it for two
    // decisions: what Start *means* (play for everybody, or walk me into a film already running),
    // and whether a room appearing is worth opening the player for — the second being a
    // `false -> true` transition that a permanently-`true` field can never make again. A rejoined
    // room therefore drew the walk-in button everywhere, and pressing it moved one device into a
    // paused film and told nobody else.
    //
    // The position is deliberately not reset: coming back should resume where the room was.
    room.state.startedAt = null;
    // Nobody is seated, so no ceiling is: the pair the room holds — and persists — is the
    // media's again, not the last leaver's. Nobody is in the room
    // to broadcast to; the next join's snapshot carries it.
    this.refreshMaturity(room);
    room.state.revision += 1;
    room.emptySince = now;

    if (this.deps.emptyRoomTtlMs <= 0) {
      this.closeRoomInternal(room, 'empty');
      return;
    }
    this.armIdleTimer(room, this.deps.emptyRoomTtlMs);
    this.deps.persist();
    this.deps.broadcastLobby();
  }

  private armIdleTimer(room: Room, delayMs: number): void {
    room.idleTimer = this.deps.setTimer(
      () => {
        room.idleTimer = null;
        // A join between arming and firing revives the room; only remove it if
        // it is still empty.
        if (room.state.participants.length === 0) this.closeRoomInternal(room, 'empty');
      },
      Math.max(0, delayMs),
    );
  }

  private clearIdle(room: Room): void {
    if (room.idleTimer !== null) {
      this.deps.clearTimer(room.idleTimer);
      room.idleTimer = null;
    }
    room.emptySince = null;
  }

  private closeRoomInternal(room: Room, reason: 'host-closed' | 'empty' | 'server-shutdown'): void {
    this.clearIdle(room);
    this.cancelPresenceFlush(room);
    this.clearDeferredHolds(room);
    this.clearEndOfItem(room);
    for (const handle of room.bufferingTimers.values()) this.deps.clearTimer(handle);
    for (const handle of room.graceTimers.values()) this.deps.clearTimer(handle);
    room.bufferingTimers.clear();
    room.graceTimers.clear();
    this.clearStallClocks(room);
    room.waitingFor.clear();
    const roomId = room.state.roomId;
    this.deps.broadcast(
      roomId,
      createServerMessage('room.closed', { reason }, { roomId, sentAt: this.deps.clock() }),
    );
    for (const p of room.state.participants) this.forgetSeat(p.participantId);
    this.deps.store.delete(roomId);
    this.deps.persist();
    // The party is gone from the store, so it drops out of the relay lobby.
    this.deps.broadcastLobby();
  }

  /**
   * Cap one seat's hold at `bufferingMaxWaitMs`. 0 — the relay's default — is no cap: the hold then
   * ends only when the seat recovers, leaves, loses its connection or is removed — and a seat that
   * stays stuck is removed after `stalledSeatRemoveMs`, which is what ends that wait.
   */
  private startBufferingTimer(room: Room, participantId: string): void {
    this.clearBufferingTimer(room, participantId);
    if (this.deps.syncConfig.bufferingMaxWaitMs <= 0) return;
    const handle = this.deps.setTimer(() => {
      room.bufferingTimers.delete(participantId);
      const timedOut = room.waitingFor.delete(participantId);
      if (timedOut && room.waitingFor.size === 0 && room.state.playback.state === 'waiting') {
        // The laggard catches up via hard seek when it recovers.
        this.mutate(room, { type: 'buffering.resumed', participantId }, () => {
          room.state.playback.state = 'playing';
        });
      }
    }, this.deps.syncConfig.bufferingMaxWaitMs);
    room.bufferingTimers.set(participantId, handle);
  }

  private clearBufferingTimer(room: Room, participantId: string): void {
    const handle = room.bufferingTimers.get(participantId);
    if (handle !== undefined) {
      this.deps.clearTimer(handle);
      room.bufferingTimers.delete(participantId);
    }
  }

  private clearBufferingWait(room: Room): void {
    for (const handle of room.bufferingTimers.values()) this.deps.clearTimer(handle);
    room.bufferingTimers.clear();
    room.waitingFor.clear();
  }

  /**
   * Whether `p`'s stall clock should be running (PROTOCOL.md § 13.4): the seat is connected
   * and its last report is `buffering`, the room's timeline is running (`playing`, or `waiting` on
   * a hold), and somebody else in the room is connected.
   *
   * Read from the **recorded** state rather than from edges, because the stall that matters most
   * has no edge: a seat that reported `buffering` in the lobby sends nothing new when Start is
   * pressed, and `armBufferingHolds` holds the room on it all the same. Either policy: under
   * pause-all everyone waits out the minute, under ignore only the stuck seat does.
   *
   * **Nobody else connected, no clock.** The removal exists for the people kept waiting or watching
   * without that seat; a party of one — or one whose other seats are all reconnecting — has
   * nobody to protect, and removing its only watcher would end the evening for nothing.
   */
  private stalls(room: Room, p: Participant): boolean {
    if (this.deps.stalledSeatRemoveMs <= 0) return false;
    if (p.connection !== 'connected' || p.playerState !== 'buffering') return false;
    const state = room.state.playback.state;
    if (state !== 'playing' && state !== 'waiting') return false;
    return room.state.participants.some(
      (other) => other.participantId !== p.participantId && other.connection === 'connected',
    );
  }

  /**
   * Arm every stall clock that should run and is not, and clear every one that should not. A clock
   * already running is left alone, so it measures **continuous** stall: repeated `buffering`
   * reports do not restart it, and anything that stops it — recovery, a pause, a new item, a
   * disconnect, a departure — resets it, so the next stall starts a fresh minute.
   */
  private syncStallClocks(room: Room): void {
    for (const p of room.state.participants) {
      const running = room.stallTimers.has(p.participantId);
      const stalls = this.stalls(room, p);
      if (stalls && !running) {
        const participantId = p.participantId;
        room.stallTimers.set(
          participantId,
          this.deps.setTimer(() => {
            room.stallTimers.delete(participantId);
            this.removeStalledSeat(room, participantId);
          }, this.deps.stalledSeatRemoveMs),
        );
      } else if (!stalls && running) {
        this.clearStallClock(room, p.participantId);
      }
    }
  }

  /**
   * The minute is up: take the seat out of the room as if it had left, and say why.
   *
   * The seat is told first, while it is still a member, so its `room.removed` names a room it
   * holds; then `removeParticipant` runs the very departure a `room.leave` runs — the hold it kept
   * resumes (§ 13), a chair it held passes on — with the reason on the cause, so every
   * other seat can say why it went. Nothing stops the person joining again by hand.
   */
  private removeStalledSeat(room: Room, participantId: string): void {
    if (this.deps.store.get(room.state.roomId) !== room) return;
    const p = room.state.participants.find((x) => x.participantId === participantId);
    if (p === undefined || !this.stalls(room, p)) return;
    const reason: RoomRemovalReason = 'stalled';
    this.deps.sendTo(
      participantId,
      createServerMessage(
        'room.removed',
        { reason },
        { roomId: room.state.roomId, sentAt: this.deps.clock() },
      ),
    );
    this.removeParticipant(room, participantId, reason);
  }

  private clearStallClock(room: Room, participantId: string): void {
    const handle = room.stallTimers.get(participantId);
    if (handle !== undefined) {
      this.deps.clearTimer(handle);
      room.stallTimers.delete(participantId);
    }
  }

  private clearStallClocks(room: Room): void {
    for (const handle of room.stallTimers.values()) this.deps.clearTimer(handle);
    room.stallTimers.clear();
  }

  /**
   * Under pause-all, hold the timeline for every connected participant whose
   * last reported player state is `buffering` (PROTOCOL.md § 13.1). Used when
   * playback (re)starts while such reports are already on record — buffering
   * reports are edge-triggered, so no new `buffering: true` will arrive.
   * Must run inside a mutate() apply callback after the state was set.
   */
  private armBufferingHolds(room: Room): void {
    if (room.state.settings.bufferingPolicy !== 'pause-all') return;
    if (room.state.playback.state !== 'playing') return;
    for (const p of room.state.participants) {
      if (
        p.connection === 'connected' &&
        p.playerState === 'buffering' &&
        !room.waitingFor.has(p.participantId)
      ) {
        room.waitingFor.add(p.participantId);
        this.startBufferingTimer(room, p.participantId);
      }
    }
    if (room.waitingFor.size > 0) room.state.playback.state = 'waiting';
  }
}
