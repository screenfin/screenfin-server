import type { RoomState } from '@screenfin/protocol';

/** Opaque timer handle; produced/consumed only by the injected timer functions. */
export type TimerHandle = unknown;

/**
 * A room as held by the server: the wire snapshot plus server-only
 * bookkeeping that never leaves the process.
 */
export interface Room {
  state: RoomState;
  /** Participants the room is currently `waiting` on (pause-all policy). */
  waitingFor: Set<string>;
  /** Per-participant `bufferingMaxWaitMs` timers. */
  bufferingTimers: Map<string, TimerHandle>;
  /**
   * Per-participant stall clocks (PROTOCOL.md § 13.4): armed while a connected seat's last
   * report is `buffering`, the room's timeline runs and somebody else is connected; fires after
   * `stalledSeatRemoveMs` and removes the seat.
   */
  stallTimers: Map<string, TimerHandle>;
  /** Per-participant `reconnectGraceMs` timers. */
  graceTimers: Map<string, TimerHandle>;
  /**
   * When the room last became empty, or null while it has participants. An
   * empty room is kept (and stays listed in the lobby) until `emptyRoomTtlMs`
   * elapses, so a reload or a relay restart does not end the party.
   */
  emptySince: number | null;
  /** The `emptyRoomTtlMs` removal timer, armed only while `emptySince` is set. */
  idleTimer: TimerHandle | null;
  /**
   * Display name of the room's most recent host. An empty room has no
   * participant to derive `lobby.state.hostName` from, and that field is not
   * allowed to be empty on the wire, so the last host's name stands in.
   */
  lastHostName: string;
  /**
   * The Jellyfin user id that may take the chair back, or null when nobody may.
   *
   * Armed when a room loses its host — it empties (`enterIdle`) or comes back off disk
   * (`restore`) — and spent by the first join from that account. It exists because a room with no
   * host hands the chair to whoever rejoins first, which under `controlMode: "host-only"` means
   * the person who set the room's rules loses control of it to whichever app's socket reconnected
   * fastest. Sessions do not survive a restart, so identity is the only thing left to recognise a
   * returning host by; the display name beside it is already persisted for the lobby.
   *
   * Cleared by an explicit `room.transferHost` and by nothing else, deliberately: the automatic
   * host paths (`joinRoom`'s idle branch and `pickNewHost`) are the very accident this corrects,
   * so letting either erase the memory would put the outcome back in the hands of reconnect
   * timing. A human deciding who holds the chair outranks a remembered one; an accident does not.
   */
  hostClaimUserId: string | null;
  /** A `client.position` report has landed but is not yet broadcast. */
  presenceDirty: boolean;
  /** Coalescing timer for presence-only broadcasts (PROTOCOL.md § 11). */
  presenceTimer: TimerHandle | null;
  /** The participant whose report armed `presenceTimer` (the broadcast cause). */
  presenceCauseParticipantId: string | null;
  /** When `presenceTimer` fires, on the injected clock; meaningless while it is `null`. */
  presenceTimerDueAt: number;
  /**
   * Per seat, when a `client.position` that changed its `playerState` last broadcast on arrival.
   * Bounds how often one seat can do that (PROTOCOL.md § 11).
   */
  stateFlushAt: Map<string, number>;
  /**
   * The Jellyfin account the room counts against for `RoomLimits.maxRoomsPerUser`: whoever created
   * it, or — for a room restored from disk, whose creator was never persisted — its last host.
   * `null` only for a document written before `lastHostUserId` existed; such a room counts against
   * nobody's cap and still against the relay's.
   */
  ownerUserId: string | null;
  /**
   * Per seat, when a `client.buffering: true` last armed a pause-all hold on arrival. Bounds how
   * often one seat can freeze and release the room (PROTOCOL.md § 13.1), on the same interval as
   * `stateFlushAt`.
   */
  holdArmedAt: Map<string, number>;
  /** Seats whose hold arrived inside their window and waits for its end (`holdTimer`). */
  deferredHolds: Set<string>;
  /** Fires when the earliest deferred hold's window closes; null while none is waiting. */
  holdTimer: TimerHandle | null;
  /** When `holdTimer` fires, on the injected clock; meaningless while it is `null`. */
  holdTimerDueAt: number;
  /**
   * Fires when a `playing` timeline reaches the runtime of an item with nothing next in the queue,
   * and stops the room's clock there. Null whenever the room is not playing such an item
   * with a known runtime; re-derived after every mutation.
   */
  endTimer: TimerHandle | null;
  /** When `endTimer` fires, on the injected clock; meaningless while it is `null`. */
  endTimerDueAt: number;
  /**
   * The runtime last learned for the item on the timeline, so a room keeps its end when the
   * visibility cache's entry ages out between refreshes. Only ever read for the same `itemId`.
   */
  itemRuntime: { itemId: string; runtimeMs: number } | null;
}

export interface RoomStore {
  get(roomId: string): Room | undefined;
  set(room: Room): void;
  delete(roomId: string): void;
  size(): number;
  all(): Iterable<Room>;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  set(room: Room): void {
    this.rooms.set(room.state.roomId, room);
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }

  size(): number {
    return this.rooms.size;
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
