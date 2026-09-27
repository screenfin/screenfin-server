import { z } from 'zod';
import { ServerCapabilitiesSchema } from './capabilities';
import { JellyfinServerIdSchema, RelayIdSchema } from './discovery';
import {
  DisplayNameSchema,
  ItemIdSchema,
  MessageIdSchema,
  ParticipantIdSchema,
  RoomIdSchema,
  RoomNameSchema,
  UnixMillisSchema,
  UserIdSchema,
} from './common';
import { ErrorCodeSchema } from './errors';
import { RoomStateSchema } from './room';
import { SyncConfigSchema } from './syncConfig';
import { EnvelopeVersionSchema } from './version';

const serverEnvelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    version: EnvelopeVersionSchema,
    id: MessageIdSchema,
    type: z.literal(type),
    roomId: RoomIdSchema.optional(),
    /** Id of the client message this responds to (acks/errors). */
    replyTo: MessageIdSchema.optional(),
    sentAt: UnixMillisSchema,
    payload,
  });

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionWelcomePayloadSchema = z.object({
  /** Sync-server session id. Also the participantId used in any room. */
  sessionId: z.string().min(4).max(64),
  /** Opaque secret for resuming this session after a disconnect. */
  resumeToken: z.string().min(16).max(128),
  /** Identity verified by the relay against Jellyfin `/Users/Me` (§ 7). */
  user: z.object({
    /** Jellyfin user id returned by the configured Jellyfin server. */
    id: UserIdSchema,
    name: DisplayNameSchema,
  }),
  /** Server clock (unix ms) when the welcome was produced. */
  serverTime: UnixMillisSchema,
  /** Effective synchronization tuning; clients MUST use these values. */
  syncConfig: SyncConfigSchema,
  /**
   * Optional server features. Current servers always send this field; readers
   * default an absent list to empty for compatibility with pre-capability relays.
   */
  capabilities: ServerCapabilitiesSchema.default([]),
  /** True when a `resume` request was honored. */
  resumed: z.boolean(),
  /** Present when the resumed session is still a participant of a room. */
  room: RoomStateSchema.nullable(),
  /**
   * Which relay this is (`relay.identity`, § 2.1). Optional and additive: a
   * pre-identity relay never sends it, and a client that verified discovery
   * uses it only to confirm the socket belongs to the key it verified.
   * `jellyfinServerId` is `null` when the relay could not read the `Id` at boot.
   */
  relay: z
    .object({
      relayId: RelayIdSchema,
      jellyfinServerId: JellyfinServerIdSchema.nullable(),
    })
    .optional(),
});

export const SessionWelcomeMessageSchema = serverEnvelope(
  'session.welcome',
  SessionWelcomePayloadSchema,
);

// ---------------------------------------------------------------------------
// Acknowledgement / error
// ---------------------------------------------------------------------------

export const AckMessageSchema = z.object({
  version: EnvelopeVersionSchema,
  id: MessageIdSchema,
  type: z.literal('ack'),
  roomId: RoomIdSchema.optional(),
  /** Required: the id of the acknowledged client message. */
  replyTo: MessageIdSchema,
  sentAt: UnixMillisSchema,
  payload: z.object({
    /** Present on acks that return a snapshot (room.create, room.join). */
    room: RoomStateSchema.optional(),
  }),
});

export const ErrorMessageSchema = serverEnvelope(
  'error',
  z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Whether re-sending the same request may succeed later. */
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

export const ROOM_STATE_CAUSES = [
  'room.created',
  'participant.joined',
  'participant.left',
  'participant.updated',
  'host.changed',
  'playback.play',
  'playback.pause',
  'playback.seek',
  'playback.setItem',
  'queue.set',
  'settings.changed',
  'buffering.waiting',
  'buffering.resumed',
  'state.request',
] as const;

/**
 * Why the relay took a seat out of a room (§ 13.4). Carried by `room.removed` to the seat
 * that was removed, and by the departure's `room.state` cause to everybody else.
 *
 * - `stalled`: the seat reported `buffering` for `STALLED_SEAT_REMOVE_MS` without a break while
 *   the room's timeline ran (one minute by default) — in the people's words, a bad connection.
 *
 * Open like a cause type: a later reason (a host's kick, should the host-kick question add one) is
 * additive, and
 * a reader that does not know a value still knows the seat was removed rather than left.
 */
export const ROOM_REMOVAL_REASONS = ['stalled'] as const;

export const RoomRemovalReasonSchema = z.enum(ROOM_REMOVAL_REASONS).or(z.string().min(1).max(64));

export const RoomStateCauseSchema = z.object({
  /**
   * Cause of the state change. Known values are listed in `ROOM_STATE_CAUSES`,
   * but new cause values are additive (PROTOCOL.md § 3) and receivers MUST
   * treat unknown values as an opaque "state changed" (§ 9.2) — so the schema
   * accepts any non-empty string and a frame carrying a future cause value is
   * never dropped. Causes feed UX (toasts) only, never state logic.
   */
  type: z.enum(ROOM_STATE_CAUSES).or(z.string().min(1).max(64)),
  /** The participant whose action or report triggered this state change. */
  participantId: ParticipantIdSchema.optional(),
  /**
   * Present only when the relay removed `participantId` rather than it leaving (§ 13.4):
   * on `participant.left`, or on `host.changed` when the removed seat held the chair. Absent on
   * every departure the seat chose, so a reader that ignores it announces a plain leave.
   */
  reason: RoomRemovalReasonSchema.optional(),
});

/** Cause values known to this protocol version (authoring aid; the wire accepts any string). */
export type KnownRoomStateCauseType = (typeof ROOM_STATE_CAUSES)[number];

export const RoomStateMessageSchema = z.object({
  version: EnvelopeVersionSchema,
  id: MessageIdSchema,
  type: z.literal('room.state'),
  roomId: RoomIdSchema,
  replyTo: MessageIdSchema.optional(),
  sentAt: UnixMillisSchema,
  payload: z.object({
    room: RoomStateSchema,
    cause: RoomStateCauseSchema,
  }),
});

export const RoomClosedMessageSchema = z.object({
  version: EnvelopeVersionSchema,
  id: MessageIdSchema,
  type: z.literal('room.closed'),
  roomId: RoomIdSchema,
  replyTo: MessageIdSchema.optional(),
  sentAt: UnixMillisSchema,
  payload: z.object({
    reason: z.enum(['host-closed', 'empty', 'server-shutdown']),
  }),
});

/**
 * Sent to one seat, and only to it, when the relay takes it out of a room (§ 13.4) — before
 * the room's own `room.state` drops it, so the frame arrives while the client still knows which
 * room it names. The session is no longer a member afterwards, exactly as after `room.leave`: the
 * client leaves the room's screens, says why, and MUST NOT rejoin that room by itself. Joining it
 * again by hand is allowed.
 *
 * Its own message rather than a `room.closed` reason: the room is not closed — everyone else is
 * still in it — and a client that reads `room.closed` as "the party is over" would be wrong about
 * that. A client that predates it ignores it (§ 9.2) and is removed server-side all the same.
 */
export const RoomRemovedMessageSchema = z.object({
  version: EnvelopeVersionSchema,
  id: MessageIdSchema,
  type: z.literal('room.removed'),
  roomId: RoomIdSchema,
  replyTo: MessageIdSchema.optional(),
  sentAt: UnixMillisSchema,
  payload: z.object({
    reason: RoomRemovalReasonSchema,
  }),
});

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

export const SyncPongMessageSchema = serverEnvelope(
  'sync.pong',
  z.object({
    /** Echo of the client's `sync.ping` clientTime. */
    clientTime: UnixMillisSchema,
    /** Server clock (unix ms) when the pong was produced. */
    serverTime: UnixMillisSchema,
  }),
);

// ---------------------------------------------------------------------------
// Lobby (server-pushed)
// ---------------------------------------------------------------------------

/**
 * One open watch party as advertised in the configured Jellyfin namespace
 * (§ 8, § 9.2).
 */
export const LobbyGroupSchema = z.object({
  roomId: RoomIdSchema,
  name: RoomNameSchema.nullable(),
  /** Display name of the room's current host. */
  hostName: DisplayNameSchema,
  participantCount: z.number().int().min(0),
  /** Maximum participants the room accepts. */
  capacity: z.number().int().min(1),
  /**
   * Item the room is currently on, or null when idle.
   *
   * **The room's maturity level is deliberately NOT here**, though it was
   * briefly: the operator ruled 2026-09-08 that it is not shown on the open-room
   * card and is shown inside the room instead, so it lives on
   * `RoomState.playback` (`room.ts`), which is what a client holds once it has
   * joined. A `LobbyGroup` is what it holds before. Leaving the pair here would
   * be wire surface whose only use is the card that was rejected.
   */
  itemId: ItemIdSchema.nullable(),
});

/**
 * The most open parties one `lobby.state` frame may advertise (§ 8.1).
 *
 * Exported because the relay has to truncate to exactly this number. The cap used to be a literal
 * here and nowhere else, while `RoomManager.lobby()` emitted one group per room in the store with
 * no bound at all — so a relay holding more rooms than this (empty rooms are held for
 * `EMPTY_ROOM_TTL_MS`, 15 minutes by default, so they accumulate) emitted a frame its own
 * published schema rejects. That is worse than a dropped frame, because the clients disagree about
 * it: a Zod-validating client rejects the whole message and loses its party rail, while the Swift
 * and Kotlin decoders enforce no maximum and carry on. One number, read by both the schema and the
 * producer, is what keeps them from drifting apart again.
 *
 * The size is not the binding constraint — a group is ~112 bytes on the wire, so 200 of them is
 * ~22 KB against the 64 KiB frame cap of § 2. It is a bound on how long a list a client is
 * required to render.
 */
export const MAX_LOBBY_GROUPS = 200;

/**
 * Server-pushed roster of open parties on this relay. Sent unsolicited at
 * welcome and whenever the open-party set changes;
 * there is no client request that produces it.
 */
export const LobbyStateMessageSchema = serverEnvelope(
  'lobby.state',
  z.object({
    groups: z.array(LobbyGroupSchema).max(MAX_LOBBY_GROUPS),
  }),
);

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion('type', [
  SessionWelcomeMessageSchema,
  AckMessageSchema,
  ErrorMessageSchema,
  RoomStateMessageSchema,
  RoomClosedMessageSchema,
  RoomRemovedMessageSchema,
  SyncPongMessageSchema,
  LobbyStateMessageSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
export type RoomStateCause = z.infer<typeof RoomStateCauseSchema>;
export type LobbyGroup = z.infer<typeof LobbyGroupSchema>;
export type RoomRemovalReason = z.infer<typeof RoomRemovalReasonSchema>;
/** Removal reasons known to this protocol version (authoring aid; the wire accepts any string). */
export type KnownRoomRemovalReason = (typeof ROOM_REMOVAL_REASONS)[number];

export const SERVER_MESSAGE_TYPES = [
  'session.welcome',
  'ack',
  'error',
  'room.state',
  'room.closed',
  'room.removed',
  'sync.pong',
  'lobby.state',
] as const satisfies readonly ServerMessageType[];
