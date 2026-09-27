import { z } from 'zod';

export const ERROR_CODES = [
  // Reserved for compatibility with pre-capability peers; current servers never emit it.
  'UNSUPPORTED_PROTOCOL_VERSION',
  'INVALID_MESSAGE',
  'NOT_AUTHENTICATED',
  'AUTH_FAILED',
  'AUTH_UNAVAILABLE',
  'AUTH_EXPIRED',
  'SESSION_RESUME_FAILED',
  'ALREADY_IN_ROOM',
  // Distinct from ALREADY_IN_ROOM, and the distinction is load-bearing: that code means "this
  // SESSION is in a room" and drives a client recovery that leaves the room first. This one means
  // "this ACCOUNT is in the room, on a different device" — the refused session is in no room and
  // has nothing to leave, so the same recovery would send a `room.leave` for a room it is not in.
  'JOINED_ON_ANOTHER_DEVICE',
  'NOT_IN_ROOM',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'FORBIDDEN',
  // Distinct from FORBIDDEN, and the distinction is the whole reason this code exists: FORBIDDEN is
  // a settled statement about a person's Jellyfin account — the § 8.1 maturity rule looked, and the
  // answer was no. This one means the server has not looked yet. It guards the same two doors and
  // refuses the same actions, but it is *retryable*: the server asks for the answer it lacked as it
  // refuses, so the same frame a moment later is decided. A client that rendered FORBIDDEN's
  // sentence here would tell someone they had been refused for their maturity ceiling when in fact
  // nobody had checked.
  'VISIBILITY_PENDING',
  'INVALID_STATE',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * WebSocket close codes used by the sync server (4000–4999 application range).
 */
export const WS_CLOSE_CODES = {
  PROTOCOL_ERROR: 4000,
  AUTH_FAILED: 4001,
  AUTH_EXPIRED: 4002,
  HELLO_TIMEOUT: 4003,
  SESSION_REPLACED: 4004,
  SERVER_SHUTDOWN: 4005,
  FORBIDDEN_ORIGIN: 4006,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];
