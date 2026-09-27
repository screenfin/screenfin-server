import { z } from 'zod';
import {
  ItemIdSchema,
  MessageIdSchema,
  ParticipantIdSchema,
  PlaybackRateSchema,
  PositionMsSchema,
  RoomIdSchema,
  RoomNameSchema,
  UnixMillisSchema,
} from './common';
import { PlayerStateSchema, QueueItemSchema, RoomSettingsSchema } from './room';
import { EnvelopeVersionSchema } from './version';

export const ClientPlatformSchema = z.enum(['web', 'ios', 'tvos', 'android', 'androidtv']);
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;

/** Printable ASCII safe to embed as the quoted Jellyfin authorization token. */
export const JellyfinTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/);

/** Envelope for messages that are not bound to a room. */
const sessionScoped = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    version: EnvelopeVersionSchema,
    id: MessageIdSchema,
    type: z.literal(type),
    roomId: RoomIdSchema.optional(),
    sentAt: UnixMillisSchema,
    payload,
  });

/** Envelope for messages that require a room context (`roomId` mandatory). */
const roomScoped = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    version: EnvelopeVersionSchema,
    id: MessageIdSchema,
    type: z.literal(type),
    roomId: RoomIdSchema,
    sentAt: UnixMillisSchema,
    payload,
  });

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionHelloPayloadSchema = z.object({
  client: z.object({
    platform: ClientPlatformSchema,
    appVersion: z.string().max(40),
    deviceName: z.string().max(64).optional(),
  }),
  /**
   * Jellyfin credential validated by the relay against its configured server.
   * Strict on purpose: obsolete asserted identity fields and unknown credential
   * keys are rejected instead of silently ignored.
   */
  auth: z.strictObject({
    jellyfinToken: JellyfinTokenSchema,
  }),
  /** Present when attempting to resume a previous session after a disconnect. */
  resume: z
    .object({
      sessionId: z.string().min(4).max(64),
      resumeToken: z.string().min(16).max(128),
    })
    .optional(),
});

export const SessionHelloMessageSchema = sessionScoped('session.hello', SessionHelloPayloadSchema);

export const SyncPingMessageSchema = sessionScoped(
  'sync.ping',
  z.object({
    /** Sender clock (unix ms) at transmission; echoed back in `sync.pong`. */
    clientTime: UnixMillisSchema,
  }),
);

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

export const RoomCreatePayloadSchema = z.object({
  name: RoomNameSchema.optional(),
  settings: RoomSettingsSchema.partial().optional(),
  /** Optionally select an initial media item at creation time. */
  item: z
    .object({
      itemId: ItemIdSchema,
      /** Defaults to 0 when omitted. */
      positionMs: PositionMsSchema.optional(),
    })
    .optional(),
});

export const RoomCreateMessageSchema = sessionScoped('room.create', RoomCreatePayloadSchema);
export const RoomJoinMessageSchema = roomScoped('room.join', z.object({}));
export const RoomLeaveMessageSchema = roomScoped('room.leave', z.object({}));
export const RoomCloseMessageSchema = roomScoped('room.close', z.object({}));

export const RoomStateRequestMessageSchema = roomScoped(
  'room.stateRequest',
  z.object({
    reason: z.enum(['reconnect', 'revision-gap', 'manual']).optional(),
  }),
);

export const RoomSetSettingsMessageSchema = roomScoped(
  'room.setSettings',
  z.object({
    settings: RoomSettingsSchema.partial(),
  }),
);

export const RoomTransferHostMessageSchema = roomScoped(
  'room.transferHost',
  z.object({
    toParticipantId: ParticipantIdSchema,
  }),
);

// ---------------------------------------------------------------------------
// Playback commands (user intent — never sent for sync corrections)
// ---------------------------------------------------------------------------

export const PlaybackPlayMessageSchema = roomScoped(
  'playback.play',
  z.object({
    /** Optional explicit start position; defaults to the authoritative position. */
    positionMs: PositionMsSchema.optional(),
  }),
);

export const PlaybackPauseMessageSchema = roomScoped(
  'playback.pause',
  z.object({
    /** Position at which the sender paused; defaults to the authoritative position. */
    positionMs: PositionMsSchema.optional(),
  }),
);

export const PlaybackSeekMessageSchema = roomScoped(
  'playback.seek',
  z.object({
    positionMs: PositionMsSchema,
  }),
);

export const PlaybackSetItemMessageSchema = roomScoped(
  'playback.setItem',
  z.object({
    itemId: ItemIdSchema,
    /** Defaults to 0 when omitted. */
    positionMs: PositionMsSchema.optional(),
    /** When the item is part of the queue, its index for queue bookkeeping. */
    queueIndex: z.number().int().min(0).optional(),
  }),
);

export const QueueSetMessageSchema = roomScoped(
  'queue.set',
  z.object({
    items: z.array(QueueItemSchema).max(500),
    queueIndex: z.number().int().min(0).nullable().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Client status reports (never treated as user commands)
// ---------------------------------------------------------------------------

export const ClientPositionMessageSchema = roomScoped(
  'client.position',
  z.object({
    positionMs: PositionMsSchema,
    playerState: PlayerStateSchema,
    rate: PlaybackRateSchema.optional(),
  }),
);

export const ClientBufferingMessageSchema = roomScoped(
  'client.buffering',
  z.object({
    buffering: z.boolean(),
    positionMs: PositionMsSchema.optional(),
  }),
);

export const ClientReadyMessageSchema = roomScoped(
  'client.ready',
  z.object({
    /** The item the client finished loading; guards against races with setItem. */
    itemId: ItemIdSchema,
  }),
);

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SessionHelloMessageSchema,
  SyncPingMessageSchema,
  RoomCreateMessageSchema,
  RoomJoinMessageSchema,
  RoomLeaveMessageSchema,
  RoomCloseMessageSchema,
  RoomStateRequestMessageSchema,
  RoomSetSettingsMessageSchema,
  RoomTransferHostMessageSchema,
  PlaybackPlayMessageSchema,
  PlaybackPauseMessageSchema,
  PlaybackSeekMessageSchema,
  PlaybackSetItemMessageSchema,
  QueueSetMessageSchema,
  ClientPositionMessageSchema,
  ClientBufferingMessageSchema,
  ClientReadyMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

export const CLIENT_MESSAGE_TYPES = [
  'session.hello',
  'sync.ping',
  'room.create',
  'room.join',
  'room.leave',
  'room.close',
  'room.stateRequest',
  'room.setSettings',
  'room.transferHost',
  'playback.play',
  'playback.pause',
  'playback.seek',
  'playback.setItem',
  'queue.set',
  'client.position',
  'client.buffering',
  'client.ready',
] as const satisfies readonly ClientMessageType[];
