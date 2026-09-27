import type WebSocket from 'ws';
import {
  WS_CLOSE_CODES,
  createServerMessage,
  extractMessageId,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type RoomState,
  type ServerMessage,
} from '@screenfin/protocol';
import { DomainError } from './errors';
import { sendFrame, type OutboundLimits } from './outbound';
import type { RoomManager } from './rooms/manager';
import type { Session } from './sessions';

export const MAX_FRAME_BYTES = 64 * 1024;

export function rawFrameToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export type DecodedFrame = { ok: true; text: string } | { ok: false; code: 'binary' | 'oversized' };

export function decodeFrame(data: WebSocket.RawData, isBinary: boolean): DecodedFrame {
  if (isBinary) return { ok: false, code: 'binary' };
  const buffer = rawFrameToBuffer(data);
  if (buffer.length > MAX_FRAME_BYTES) return { ok: false, code: 'oversized' };
  return { ok: true, text: buffer.toString('utf8') };
}

export interface RouterLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface RouterDeps {
  manager: RoomManager;
  clock: () => number;
  logger?: RouterLogger;
  /** Security review H2; `DEFAULT_OUTBOUND_LIMITS` when omitted. */
  outboundLimits?: OutboundLimits;
}

export interface MessageRouter {
  handleMessage(session: Session, data: WebSocket.RawData, isBinary: boolean): void;
}

type PostAuthMessage = Exclude<ClientMessage, { type: 'session.hello' | 'sync.ping' }>;

/**
 * Post-authentication message pipeline: frame checks, schema validation,
 * idempotency, rate limiting, dispatch to the room manager, exactly one
 * ack/error per non-ping message.
 */
export function createRouter(deps: RouterDeps): MessageRouter {
  const { manager, clock, logger } = deps;

  // Everything the router sends is an answer to something the client said, so nothing here is
  // ever skipped — but a reader past the hard bound is closed here as everywhere else.
  const sendRaw = (session: Session, serialized: string): void => {
    const socket = session.socket;
    if (socket === null) return;
    sendFrame(socket, serialized, {
      droppable: false,
      ...(deps.outboundLimits !== undefined ? { limits: deps.outboundLimits } : {}),
    });
  };

  const send = (session: Session, message: ServerMessage): void => {
    sendRaw(session, JSON.stringify(message));
  };

  const sendError = (
    session: Session,
    code: ErrorCode,
    message: string,
    opts: { replyTo?: string; roomId?: string; retryable?: boolean } = {},
  ): void => {
    send(
      session,
      createServerMessage(
        'error',
        { code, message, retryable: opts.retryable ?? false },
        { replyTo: opts.replyTo, roomId: opts.roomId, sentAt: clock() },
      ),
    );
  };

  const dispatch = (session: Session, message: PostAuthMessage): ServerMessage => {
    const participantId = session.sessionId;
    const info = {
      participantId,
      userId: session.userId,
      userName: session.userName,
      // The account's Jellyfin ceiling, for the room's displayed level. Never broadcast as a
      // number; see `ParticipantInfo.maturityCeiling`.
      maturityCeiling: session.maturityCeiling,
      // Carried so a second device of this account can be told which of its own devices is
      // already in the room. Never broadcast; see `ParticipantInfo.deviceName`.
      ...(session.deviceName === null ? {} : { deviceName: session.deviceName }),
    };
    const ack = (
      payload: { room?: RoomState },
      roomId?: string,
    ): ServerMessage =>
      createServerMessage('ack', payload, { replyTo: message.id, roomId, sentAt: clock() });

    switch (message.type) {
      case 'room.create': {
        const room = manager.createRoom(info, message.payload);
        return ack({ room }, room.roomId);
      }
      case 'room.join': {
        const room = manager.joinRoom(info, message.roomId);
        return ack({ room }, room.roomId);
      }
      case 'room.leave':
        manager.leaveRoom(participantId, message.roomId);
        // Logged at the same level as "session established" / "session resumed", and for the same
        // reason: it is one of the handful of events that change who is in a party. It is also the
        // only way to tell a client that *left* from one whose socket merely died — the two look
        // identical in a roster afterwards, and clients now leave on their way out of the app, so
        // "did the leave arrive" became a question worth being able to answer from a log.
        logger?.info(
          { sessionId: session.sessionId, roomId: message.roomId },
          'participant left room',
        );
        return ack({}, message.roomId);
      case 'room.close':
        manager.closeRoom(participantId, message.roomId);
        return ack({}, message.roomId);
      case 'room.stateRequest':
        manager.requestState(participantId, message.roomId, message.id);
        return ack({}, message.roomId);
      case 'room.setSettings':
        manager.setSettings(participantId, message.roomId, message.payload.settings);
        return ack({}, message.roomId);
      case 'room.transferHost':
        manager.transferHost(participantId, message.roomId, message.payload.toParticipantId);
        return ack({}, message.roomId);
      case 'playback.play':
        manager.play(participantId, message.roomId, message.payload.positionMs);
        return ack({}, message.roomId);
      case 'playback.pause':
        manager.pause(participantId, message.roomId, message.payload.positionMs);
        return ack({}, message.roomId);
      case 'playback.seek':
        manager.seek(participantId, message.roomId, message.payload.positionMs);
        return ack({}, message.roomId);
      case 'playback.setItem':
        manager.setItem(participantId, message.roomId, message.payload);
        return ack({}, message.roomId);
      case 'queue.set':
        manager.setQueue(participantId, message.roomId, message.payload);
        return ack({}, message.roomId);
      case 'client.position':
        manager.reportPosition(participantId, message.roomId, message.payload);
        return ack({}, message.roomId);
      case 'client.buffering':
        manager.reportBuffering(participantId, message.roomId, message.payload);
        return ack({}, message.roomId);
      case 'client.ready':
        manager.reportReady(participantId, message.roomId, message.payload.itemId);
        return ack({}, message.roomId);
    }
  };

  const handleMessage = (session: Session, data: WebSocket.RawData, isBinary: boolean): void => {
    // Flood guard: charged before any decode/parse/idempotency work so that
    // malformed frames and replayed message ids cannot bypass rate limiting
    // (PROTOCOL.md § 6.4). The generous report bucket is used because the
    // frame type is not known yet; commands are additionally charged against
    // the stricter command bucket below.
    if (!session.reportBucket.tryTake()) {
      sendError(session, 'RATE_LIMITED', 'too many messages', { retryable: true });
      return;
    }

    const decoded = decodeFrame(data, isBinary);
    if (!decoded.ok) {
      sendError(
        session,
        'INVALID_MESSAGE',
        decoded.code === 'binary'
          ? 'binary frames are not supported'
          : 'frame exceeds the 64 KiB limit',
      );
      session.socket?.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'protocol violation');
      return;
    }

    const parsed = parseClientMessage(decoded.text);
    if (!parsed.ok) {
      const replyTo = extractMessageId(decoded.text);
      sendError(session, 'INVALID_MESSAGE', 'malformed or schema-invalid message', { replyTo });
      // Repeated violations escalate to a close (PROTOCOL.md § 6.4).
      if (session.registerInvalidFrame()) {
        session.socket?.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'repeated invalid messages');
      }
      return;
    }
    session.resetInvalidFrames();

    const message = parsed.message;
    if (message.type === 'session.hello') {
      sendError(session, 'INVALID_STATE', 'session is already authenticated', {
        replyTo: message.id,
      });
      return;
    }

    if (message.type === 'sync.ping') {
      send(
        session,
        createServerMessage(
          'sync.pong',
          { clientTime: message.payload.clientTime, serverTime: clock() },
          { sentAt: clock() },
        ),
      );
      return;
    }

    // Idempotency: a duplicate id is answered from cache and never re-applied.
    // (The flood-guard charge above still applied, so replaying one cached id
    // in a tight loop cannot amplify bandwidth for free.)
    const cached = session.cachedReply(message.id);
    if (cached !== undefined) {
      // An ack that carried a room is replayed with the room as it is now, if this session is
      // still in it — and without one if it is not, rather than with a room it has left.
      const room =
        cached.roomId === undefined
          ? null
          : manager.memberSnapshot(cached.roomId, session.sessionId);
      if (room === null) {
        sendRaw(session, cached.serialized);
      } else {
        const ack = JSON.parse(cached.serialized) as { payload: Record<string, unknown> };
        sendRaw(session, JSON.stringify({ ...ack, payload: { ...ack.payload, room } }));
      }
      return;
    }

    // client.position rides the report-bucket charge taken above; everything
    // else is a command and must also fit the stricter command budget.
    if (message.type !== 'client.position' && !session.commandBucket.tryTake()) {
      sendError(session, 'RATE_LIMITED', 'too many messages', {
        replyTo: message.id,
        roomId: message.roomId,
        retryable: true,
      });
      return;
    }

    let reply: ServerMessage;
    try {
      reply = dispatch(session, message);
    } catch (err) {
      if (err instanceof DomainError) {
        reply = createServerMessage(
          'error',
          { code: err.code, message: err.message, retryable: err.retryable },
          { replyTo: message.id, roomId: message.roomId, sentAt: clock() },
        );
      } else {
        logger?.error(
          { err, type: message.type, sessionId: session.sessionId },
          'unexpected failure while handling message',
        );
        reply = createServerMessage(
          'error',
          { code: 'INTERNAL', message: 'unexpected server failure', retryable: true },
          { replyTo: message.id, sentAt: clock() },
        );
      }
    }

    const serialized = JSON.stringify(reply);
    // Retryable failures (RATE_LIMITED, INTERNAL) must be re-attemptable.
    if (reply.type === 'ack' && reply.payload.room !== undefined) {
      // Kept without the room (security review L9); see `CachedReply`.
      const { room, ...rest } = reply.payload;
      session.cacheReply(message.id, {
        serialized: JSON.stringify({ ...reply, payload: rest }),
        roomId: room.roomId,
      });
    } else if (reply.type === 'ack' || (reply.type === 'error' && !reply.payload.retryable)) {
      session.cacheReply(message.id, { serialized });
    }
    sendRaw(session, serialized);
  };

  return { handleMessage };
}
