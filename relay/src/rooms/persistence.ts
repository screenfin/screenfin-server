import { z } from 'zod';
import {
  DisplayNameSchema,
  RoomPlaybackSchema,
  RoomStateSchema,
  UnixMillisSchema,
  UserIdSchema,
  expectedPositionMs,
  type RoomState,
} from '@screenfin/protocol';
import type { FileStorage } from '../fileStore';
import type { Room, RoomStore, TimerHandle } from './store';

/** Bumped only for an incompatible document layout; older documents are ignored. */
const DOCUMENT_VERSION = 1;

/**
 * Trailing-write cadence: at most one disk write per this window while dirty.
 *
 * The window is what bounds flash wear on the small hosts this is expected to
 * run on: a live party mutates several times a second, and every mutation moves
 * the persisted position. A graceful shutdown flushes exactly, so this only
 * bounds how much timeline an unclean stop can lose.
 */
const DEFAULT_SAVE_INTERVAL_MS = 30_000;

/**
 * Restored rooms resume from the persisted revision plus this margin.
 *
 * A client that was in the room when the relay went down may have applied
 * revisions produced *after* the last snapshot reached disk, and clients drop
 * any snapshot whose revision is not greater than the last one they applied
 * (PROTOCOL.md § 6.3). Without the margin, such a client would rejoin and then
 * silently ignore the restored room state.
 */
const RESTORE_REVISION_MARGIN = 1_000;

/**
 * The most rooms one document carries, on the way out **and** on the way in.
 *
 * These used to disagree, and the disagreement ended every party at once: `write` saved any
 * number of rooms while `load` refused a document holding more than a thousand — the whole
 * document, not the excess — so a relay flooded past that number (measured: 1,100 rooms from one
 * account in 18 s, security review H1) restarted with none. `RoomLimits.maxRooms` now keeps a relay
 * well under this, and `MAX_ROOMS` cannot be configured above it; the two ends still agree on
 * their own, so no future cap can bring the failure back.
 */
export const MAX_PERSISTED_ROOMS = 1_000;

/**
 * `rooms.json` holds user ids, host display names and room names — no token, ever (see
 * `project`) — and nobody but the relay has a reason to read it.
 */
const ROOMS_FILE_MODE = 0o600;

/**
 * The room snapshot as it may appear *on disk*, which is not quite the room
 * snapshot on the wire.
 *
 * `startedAt` was added after the first documents were written, and
 * `RoomsDocumentSchema` failing is not a soft failure — `load` discards every
 * room and logs, so a strict read here would end every persisted party on the
 * upgrade that introduced the field. That is precisely what persistence exists
 * to prevent, so the field is optional on the way in and backfilled below.
 *
 * **Absent and `null` mean different things and the distinction is load-bearing.**
 * A relay that speaks `startedAt` writes an explicit `null` for a party sitting
 * in its lobby, and that must survive a restart as a lobby. Only a genuinely
 * absent key is a document from before the field existed — and such a document
 * was written under the old model, where a room holding an item was a room
 * already watching. `createdAt` is the honest backfill for those; a room with no
 * item never started under either model.
 */
const PersistedRoomStateSchema = RoomStateSchema.extend({
  startedAt: UnixMillisSchema.nullable().optional(),
  /**
   * The maturity rule's display pair, optional for exactly the reason `startedAt` is: a
   * document written before it existed would otherwise fail the whole
   * `RoomsDocumentSchema` and end every persisted party on the upgrade.
   *
   * Unlike `startedAt` there is nothing to infer, and nothing is lost by not
   * inferring: it is derived from the visibility cache, which is empty at boot
   * anyway, and `RoomManager` re-materializes it the first time the room is
   * described. `null`/`false` is the honest "nothing resolved yet".
   */
  playback: RoomPlaybackSchema.partial({ maturityRating: true, containsUnrated: true }),
}).transform((state): RoomState => ({
  ...state,
  startedAt:
    state.startedAt !== undefined
      ? state.startedAt
      : state.playback.itemId !== null
        ? state.createdAt
        : null,
  playback: {
    ...state.playback,
    maturityRating: state.playback.maturityRating ?? null,
    containsUnrated: state.playback.containsUnrated ?? false,
  },
}));

const PersistedRoomSchema = z.object({
  state: PersistedRoomStateSchema,
  /** When the room lost its last participant; null only for a room saved live. */
  emptySince: UnixMillisSchema.nullable(),
  lastHostName: DisplayNameSchema,
  /**
   * The host's Jellyfin user id, beside the display name that was already here.
   *
   * A restart empties every room, and an empty room hands the chair to whoever rejoins first —
   * cosmetic under `controlMode: "everyone"`, and under `host-only` it takes the room away from
   * the person who set its rules and gives it to whichever app reconnected fastest. Sessions are
   * deliberately not persisted, so the account is the only thing a returning host can be
   * recognised by. Membership itself stays unpersisted for the reason `restore` gives: a saved
   * roster is a list of people who are not there.
   *
   * Optional and defaulted, because `load` discards the whole document on a schema failure and a
   * strict field would end every persisted party on the upgrade that introduced it. Absent means
   * the pre-field behaviour, which is exactly what those documents were written under.
   */
  lastHostUserId: UserIdSchema.nullable().optional().default(null),
});

/**
 * The document's frame. The rooms inside it are parsed **one at a time** in `load`, so a room that
 * fails the schema costs that room and not every party beside it, and an oversized list (written by
 * a relay from before `MAX_PERSISTED_ROOMS` bound `write`) is read up to the bound rather than
 * refused whole.
 */
const RoomsDocumentSchema = z.object({
  version: z.literal(DOCUMENT_VERSION),
  savedAt: UnixMillisSchema,
  rooms: z.array(z.unknown()),
});

export type PersistedRoom = z.infer<typeof PersistedRoomSchema>;

export interface RoomPersistenceLogger {
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
}

export interface RoomPersistenceDeps {
  /** Where the rooms document lives (`ROOMS_PATH`). */
  path: string;
  storage: FileStorage;
  store: RoomStore;
  clock: () => number;
  setTimer: (fn: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** Trailing-write window; the default keeps a busy relay to one write per 30 s. */
  saveIntervalMs?: number;
  logger?: RoomPersistenceLogger;
}

/**
 * Durable room storage, so a container restart does not end every watch party
 * (ROADMAP.md phase 5).
 *
 * The document is a *projection*, not a live dump: sockets never survive a
 * restart, so a saved room carries no participants and a frozen timeline —
 * exactly the shape an empty room has while it waits out `EMPTY_ROOM_TTL_MS`.
 * Restoring is therefore the same code path as a party whose last viewer
 * stepped away: whoever comes back first rejoins by room id and becomes host.
 */
export class RoomPersistence {
  private readonly saveIntervalMs: number;
  private dirty = false;
  private timer: TimerHandle | null = null;
  /** Suppresses repeat write warnings for one failure streak. */
  private writeFailed = false;

  constructor(private readonly deps: RoomPersistenceDeps) {
    this.saveIntervalMs = deps.saveIntervalMs ?? DEFAULT_SAVE_INTERVAL_MS;
  }

  /**
   * Read the persisted rooms. A missing file is the normal first-boot case; a
   * malformed one is logged and ignored, because an operator whose relay
   * refuses to start over a half-written room document is worse off than one
   * whose parties were lost.
   */
  load(): PersistedRoom[] {
    let raw: string;
    try {
      raw = this.deps.storage.read(this.deps.path);
    } catch {
      return [];
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      this.deps.logger?.warn(
        { path: this.deps.path },
        'persisted rooms are not valid JSON; starting with no rooms',
      );
      return [];
    }
    const parsed = RoomsDocumentSchema.safeParse(document);
    if (!parsed.success) {
      this.deps.logger?.warn(
        { path: this.deps.path },
        'persisted rooms do not match the current schema; starting with no rooms',
      );
      return [];
    }
    // `write` puts the rooms worth keeping first, so the bound drops the least valuable.
    const candidates = parsed.data.rooms.slice(0, MAX_PERSISTED_ROOMS);
    const rooms: PersistedRoom[] = [];
    for (const candidate of candidates) {
      const room = PersistedRoomSchema.safeParse(candidate);
      if (room.success) rooms.push(room.data);
    }
    const dropped = parsed.data.rooms.length - rooms.length;
    if (dropped > 0) {
      this.deps.logger?.warn(
        { path: this.deps.path, dropped, restored: rooms.length },
        'some persisted rooms were malformed or over the limit and were not restored',
      );
    }
    return rooms.map((room) => ({
      ...room,
      state: { ...room.state, revision: room.state.revision + RESTORE_REVISION_MARGIN },
    }));
  }

  /** Note that room state changed; the write happens on the next save window. */
  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.write();
    }, this.saveIntervalMs);
  }

  /**
   * Write immediately if anything is pending (shutdown, or a test). Returns
   * false only when a pending write failed, so a caller shutting down can tell
   * clients the parties are gone rather than leaving them to reconnect into
   * rooms that were never saved.
   */
  flush(): boolean {
    this.cancelTimer();
    return this.dirty ? this.write() : true;
  }

  /** Drop the pending save window without writing (teardown). */
  stop(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private write(): boolean {
    const now = this.deps.clock();
    const all = [...this.deps.store.all()];
    // Live rooms first, then the most recently emptied — the lobby's own order, and the order in
    // which a restart should lose them if it must lose any.
    const ordered = [
      ...all.filter((room) => room.emptySince === null),
      ...all
        .filter((room) => room.emptySince !== null)
        .sort((a, b) => (b.emptySince ?? 0) - (a.emptySince ?? 0)),
    ];
    if (ordered.length > MAX_PERSISTED_ROOMS) {
      this.deps.logger?.warn(
        { path: this.deps.path, rooms: ordered.length, persisted: MAX_PERSISTED_ROOMS },
        'more rooms than the rooms document holds; the longest-idle ones will not survive a restart',
      );
    }
    const rooms = ordered.slice(0, MAX_PERSISTED_ROOMS).map((room) => project(room, now));
    this.dirty = false;
    try {
      this.deps.storage.write(
        this.deps.path,
        `${JSON.stringify({ version: DOCUMENT_VERSION, savedAt: now, rooms }, null, 2)}\n`,
        { mode: ROOMS_FILE_MODE },
      );
      if (this.writeFailed) {
        this.writeFailed = false;
        this.deps.logger?.info({ path: this.deps.path }, 'rooms are being persisted again');
      }
      return true;
    } catch (error) {
      // Never fatal: a relay that cannot write its rooms still coordinates
      // parties perfectly well, it just forgets them on restart.
      if (!this.writeFailed) {
        this.writeFailed = true;
        this.deps.logger?.warn(
          { path: this.deps.path, err: error },
          'could not persist rooms; parties will not survive a restart',
        );
      }
      return false;
    }
  }
}

/**
 * The room as it would be found after a restart: no participants (their sockets
 * are gone) and a timeline frozen at the position it holds right now, so the
 * party does not silently advance while the relay is down.
 */
function project(room: Room, now: number): PersistedRoom {
  const playback = room.state.playback;
  const state: RoomState = {
    ...room.state,
    playback: {
      ...playback,
      positionMs: expectedPositionMs(playback, now),
      measuredAt: now,
      state:
        playback.state === 'playing' || playback.state === 'waiting' ? 'paused' : playback.state,
    },
    participants: [],
  };
  const host = room.state.participants.find(
    (p) => p.participantId === room.state.hostParticipantId,
  );
  return {
    state,
    emptySince: room.emptySince ?? now,
    lastHostName: host?.userName ?? room.lastHostName,
    // The live host if there is one, because a restart empties the room and the person holding
    // the chair when the relay went down is the person it should come back to. An already-idle
    // room has nobody to read, and its armed claim is that same value recorded when it emptied.
    lastHostUserId: host?.userId ?? room.hostClaimUserId,
  };
}
