import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import {
  SERVER_CAPABILITIES,
  WS_CLOSE_CODES,
  createServerMessage,
  extractMessageId,
  parseClientMessage,
  type ClientMessageOf,
  type ErrorCode,
  type RoomState,
  type ServerMessage,
} from '@screenfin/protocol';
import type { JellyfinAuthenticator, JellyfinUser } from './identity';
import type { AppConfig } from './config';
import type { JellyfinBinding } from './jellyfinBinding';
import { DEFAULT_OUTBOUND_LIMITS, sendFrame, type OutboundLimits } from './outbound';
import { createFixedWindowLimiter } from './rateLimit';
import type { RelayIdentity } from './relayIdentity';
import type { RoomManager } from './rooms/manager';
import { decodeFrame, type MessageRouter } from './router';
import type { ItemVisibilityWarmer } from './visibility';
import type { Session, SessionRegistry } from './sessions';

type ResumePayload = NonNullable<ClientMessageOf<'session.hello'>['payload']['resume']>;

export interface ConnectionLayerDeps {
  config: AppConfig;
  authenticator: JellyfinAuthenticator;
  registry: SessionRegistry;
  manager: RoomManager;
  router: MessageRouter;
  clock: () => number;
  logger: FastifyBaseLogger;
  /** The maturity rule. Warmed here because this is one of the few places that may await. */
  visibility: ItemVisibilityWarmer;
  /** Named in every welcome (`relay.identity`, PROTOCOL.md § 7). */
  identity: RelayIdentity;
  /** The Jellyfin `Id` the welcome reports; `null` while unknown. */
  binding: JellyfinBinding;
  /** Security review H2; `DEFAULT_OUTBOUND_LIMITS` when omitted. */
  outboundLimits?: OutboundLimits;
}

export interface ConnectionLayer {
  handleConnection(socket: WebSocket, request: FastifyRequest): void;
  /** Start the liveness sweep. */
  start(): void;
  stop(): void;
  closeAll(code: number, reason: string): void;
}

/**
 * Per-connection lifecycle: origin check, hello timeout, Jellyfin
 * authentication and resume (PROTOCOL.md § 7), then message routing. Also owns
 * liveness and periodic credential revalidation.
 */
const HELLO_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

/**
 * Collapse a client address into the key used for pre-authentication abuse caps.
 *
 * Two reasons this is not the raw address:
 *  - `::ffff:1.2.3.4` and `1.2.3.4` are the same host and must share one bucket,
 *    otherwise the caps disagree with themselves depending on how the socket
 *    was accepted.
 *  - A single residential IPv6 allocation is a /64 or larger, so per-address
 *    counting caps nothing at all: an abuser rotates addresses for free.
 *    Truncating to the /64 makes the bucket the allocation, not the address.
 */
export function capKey(ip: string): string {
  // Lowercase FIRST: IPv6 is case-insensitive, so `::FFFF:1.2.3.4` must fold the
  // same way as `::ffff:1.2.3.4`. Matching case-sensitively sent the uppercase
  // form down the IPv6 path, where it truncated to `0:0:0:0::/64` — sharing a
  // bucket with `::1` and with every other unrecognised form.
  const lowered = ip.toLowerCase();
  // Strip an IPv6 zone id (fe80::1%en0) before anything else.
  const zoneless = lowered.split('%')[0] ?? lowered;
  const bare = zoneless.startsWith('::ffff:') ? zoneless.slice('::ffff:'.length) : zoneless;
  if (!bare.includes(':')) return bare;

  // IPv6: keep the first four hextets (the /64), expanding a '::' elision first.
  const elided = bare.includes('::');
  const [head = '', tail = ''] = bare.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const parts = elided
    ? [
        ...headParts,
        ...(Array(Math.max(0, 8 - headParts.length - tailParts.length)) as string[]).fill('0'),
        ...tailParts,
      ]
    : headParts;

  const prefix = parts.slice(0, 4).map((part) => part.toLowerCase().replace(/^0+(?=.)/, ''));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}

/**
 * Effective client address. Delegates to Fastify's `request.ip`, which honors
 * X-Forwarded-For ONLY per the configured `trustProxy` (default: not at all)
 * and correctly walks the header from the right. Reading the header directly
 * would let any client forge its own bucket and void every per-IP cap.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip !== undefined && request.ip !== ''
    ? request.ip
    : (request.socket.remoteAddress ?? 'unknown');
}

/** The window every pre-authentication per-address limit counts in. */
export const PRE_AUTH_WINDOW_MS = HELLO_WINDOW_MS;
export const MAX_TRACKED_PRE_AUTH_IPS = MAX_TRACKED_IPS;

export function createConnectionLayer(deps: ConnectionLayerDeps): ConnectionLayer {
  const { config, authenticator, registry, manager, router, clock, logger, visibility } = deps;
  const openSockets = new Set<WebSocket>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** True once stop() ran; close handlers then skip arming resume-grace timers. */
  let stopped = false;
  /** Sockets that have connected but not yet sent a valid `session.hello`. */
  let pendingSockets = 0;
  /** The same, split per client address, so one host cannot consume the global pool. */
  const pendingByIp = new Map<string, number>();
  /** Fixed-window `session.hello` counters per client IP. */
  const helloLimiter = createFixedWindowLimiter({
    clock,
    windowMs: HELLO_WINDOW_MS,
    limit: config.helloRateLimitPerIp,
    maxTracked: MAX_TRACKED_IPS,
  });
  const takeHelloSlot = (ip: string): boolean => helloLimiter.take(ip);
  /**
   * Every socket still waiting for its `session.hello`, oldest first, with how to close it.
   *
   * Security review H3: behind a reverse proxy with `TRUST_PROXY` unset, every client has the
   * proxy's address, so the per-address cap is one bucket for the whole user base — and ten idle
   * sockets from one anonymous client, re-opened as each timed out, locked everybody else out.
   * A full bucket now makes room by closing its **oldest socket that has not sent a hello**. A
   * real client says hello within a round trip of opening, so it is never the oldest for long; an
   * idle holder is always the oldest, and holding the pool now takes a sustained flood of new
   * sockets rather than ten. The counts never pass their caps either way, and a socket whose
   * hello is already being validated is never closed for this — if every pending socket is one of
   * those, the new one is refused as before.
   */
  const pendingOrder = new Map<WebSocket, { ip: string; idle: () => boolean; evict: () => void }>();
  /** Close the oldest idle pending socket — from `ip` when given — and say whether one was. */
  const evictOldestIdle = (ip?: string): boolean => {
    for (const entry of pendingOrder.values()) {
      if (ip !== undefined && entry.ip !== ip) continue;
      if (!entry.idle()) continue;
      entry.evict();
      return true;
    }
    return false;
  };

  const handleConnection = (socket: WebSocket, request: FastifyRequest): void => {
    let session: Session | null = null;
    /** Guards against concurrent hello validation on one socket. */
    let helloInFlight = false;
    let helloTimer: ReturnType<typeof setTimeout> | null = null;

    const ip = capKey(clientIp(request));

    // Slow-loris guard: cap sockets loitering before hello.
    //
    // Bounded on BOTH axes on purpose. The global counter bounds total memory;
    // the per-address one stops a single host from consuming the entire global
    // pool and locking every other user out — a socket holds its slot for
    // helloTimeoutMs and can be re-opened indefinitely, and the address is the
    // only property of a pre-hello connection that cannot be forged (given
    // TRUST_PROXY). Hello-attempt limits use the same address key; authenticated
    // session limits switch to the Jellyfin-verified user id.
    const admitted =
      ((pendingByIp.get(ip) ?? 0) < config.maxPendingSocketsPerIp || evictOldestIdle(ip)) &&
      (pendingSockets < config.maxPendingSockets || evictOldestIdle());
    if (!admitted) {
      logger.warn({ ip }, 'rejected websocket connection: too many unauthenticated sockets');
      socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'too many pending connections');
      return;
    }
    pendingSockets += 1;
    pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
    let pendingReleased = false;
    const releasePending = (): void => {
      if (!pendingReleased) {
        pendingReleased = true;
        pendingOrder.delete(socket);
        pendingSockets -= 1;
        const remaining = (pendingByIp.get(ip) ?? 1) - 1;
        // Delete at zero so the map cannot grow without bound across addresses.
        if (remaining <= 0) pendingByIp.delete(ip);
        else pendingByIp.set(ip, remaining);
      }
    };

    pendingOrder.set(socket, {
      ip,
      idle: () => !helloInFlight,
      evict: () => {
        releasePending();
        socket.close(WS_CLOSE_CODES.HELLO_TIMEOUT, 'superseded by a newer connection');
      },
    });
    openSockets.add(socket);
    socket.on('error', () => {
      // 'close' always follows; nothing to do beyond preventing a crash.
    });

    const send = (message: ServerMessage, droppable = false): void => {
      sendFrame(socket, JSON.stringify(message), {
        droppable,
        ...(deps.outboundLimits !== undefined ? { limits: deps.outboundLimits } : {}),
      });
    };

    const sendError = (
      code: ErrorCode,
      message: string,
      replyTo: string | undefined,
      retryable = false,
    ): void => {
      send(
        createServerMessage('error', { code, message, retryable }, { replyTo, sentAt: clock() }),
      );
    };

    const armHelloTimer = (): void => {
      helloTimer = setTimeout(() => {
        helloTimer = null;
        socket.close(WS_CLOSE_CODES.HELLO_TIMEOUT, 'no session.hello received');
      }, config.helloTimeoutMs);
    };

    socket.on('close', () => {
      openSockets.delete(socket);
      releasePending();
      if (helloTimer !== null) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
      const current = session;
      if (current === null || current.socket !== socket) return;
      current.socket = null;
      current.disconnectedAt = clock();
      manager.handleDisconnect(current.sessionId);
      if (stopped) {
        // Shutdown in progress: no resume can arrive, so arming a
        // reconnectGraceMs cleanup timer would only hold the event loop open
        // after app.close() resolves. Free the session immediately.
        manager.destroySession(current.sessionId);
        registry.delete(current.sessionId);
        return;
      }
      current.cleanupTimer = setTimeout(() => {
        current.cleanupTimer = null;
        if (current.socket === null) {
          manager.destroySession(current.sessionId);
          registry.delete(current.sessionId);
          logger.info({ sessionId: current.sessionId }, 'session expired after grace period');
        }
      }, config.syncConfig.reconnectGraceMs);
    });

    const origin = request.headers.origin;
    if (
      config.allowedOrigins.length > 0 &&
      origin !== undefined &&
      !config.allowedOrigins.includes(origin)
    ) {
      logger.warn({ origin }, 'rejected websocket connection from disallowed origin');
      socket.close(WS_CLOSE_CODES.FORBIDDEN_ORIGIN, 'origin not allowed');
      return;
    }

    const sendWelcome = (
      welcomed: Session,
      replyTo: string,
      resumed: boolean,
      room: RoomState | null,
    ): void => {
      send(
        createServerMessage(
          'session.welcome',
          {
            sessionId: welcomed.sessionId,
            resumeToken: welcomed.resumeToken,
            user: { id: welcomed.userId, name: welcomed.userName },
            serverTime: clock(),
            syncConfig: config.syncConfig,
            capabilities: SERVER_CAPABILITIES,
            resumed,
            room,
            relay: { relayId: deps.identity.relayId, jellyfinServerId: deps.binding.current() },
          },
          { replyTo, sentAt: clock() },
        ),
      );
    };

    /**
     * Resolve the maturity rule visibility for everything the rooms hold, then push this
     * session's first roster.
     *
     * This is the primary warm: `RoomManager.lobbyFor` and `joinRoom` read the
     * cache **synchronously** (the router has no `await` anywhere in it), so the
     * answers have to be in place before a client is shown anything. Hello is
     * already asynchronous and the welcome has already gone out, so nothing the
     * client is waiting on is delayed — only the roster, and only until Jellyfin
     * answers or the request times out.
     *
     * A failure warms nothing and the roster goes out unfiltered, which is
     * The maturity rule's chosen direction: _"a failure to resolve is not a refusal"_.
     */
    const sendSeededLobby = async (target: Session, token: string): Promise<void> => {
      try {
        await visibility.warm(target.userId, token, manager.itemIdsInRooms());
      } catch (err) {
        // The warm is documented never to reject, and a hello must not become an
        // unhandled rejection if that ever stops being true. Fail open: the
        // roster still goes out, exactly as it would have before the maturity rule.
        logger.warn({ err, sessionId: target.sessionId }, 'lobby visibility warm failed');
      }
      // The socket may have gone, or the session may have been resumed onto a
      // different one, while the request was out.
      if (target.socket !== socket || socket.readyState !== socket.OPEN) return;
      send(
        createServerMessage(
          'lobby.state',
          { groups: manager.lobbyFor(target.userId) },
          { sentAt: clock() },
        ),
        true,
      );
    };

    const resumableSession = (
      resume: ResumePayload,
      user: JellyfinUser,
      now: number,
    ): Session | null => {
      const existing = registry.get(resume.sessionId);
      if (existing === undefined) return null;
      if (!existing.verifyResumeToken(resume.resumeToken)) return null;
      if (existing.userId !== user.userId) return null;
      const withinGrace =
        existing.socket !== null ||
        (existing.disconnectedAt !== null &&
          now - existing.disconnectedAt <= config.syncConfig.reconnectGraceMs);
      return withinGrace ? existing : null;
    };

    const handleHello = async (data: WebSocket.RawData, isBinary: boolean): Promise<void> => {
      // Frames buffered before a failure path called socket.close() can still be
      // delivered afterwards. Without this guard a malformed frame (which closes
      // the socket but consumes no hello slot) followed by a valid hello in the
      // same batch would mint a session on a CLOSING socket: the welcome is
      // never sent, but the session sits in the registry holding a slot until
      // its reconnect grace elapses. Keep this explicit around the asynchronous
      // Jellyfin validation below.
      if (socket.readyState !== socket.OPEN) return;

      const decoded = decodeFrame(data, isBinary);
      if (!decoded.ok) {
        sendError(
          'INVALID_MESSAGE',
          decoded.code === 'binary'
            ? 'binary frames are not supported'
            : 'frame exceeds the 64 KiB limit',
          undefined,
        );
        socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'protocol violation');
        return;
      }
      const parsed = parseClientMessage(decoded.text);
      if (!parsed.ok) {
        const replyTo = extractMessageId(decoded.text);
        sendError('INVALID_MESSAGE', 'malformed or schema-invalid message', replyTo);
        return;
      }
      const message = parsed.message;
      if (message.type !== 'session.hello') {
        sendError('NOT_AUTHENTICATED', 'authenticate with session.hello first', message.id);
        return;
      }
      if (helloInFlight) {
        // A second frame can arrive while Jellyfin validation is in flight. Reject
        // it without starting another upstream request. Non-retryable so the wire
        // matches PROTOCOL.md § 14, which lists INVALID_STATE as never retryable.
        sendError('INVALID_STATE', 'authentication is already in progress', message.id);
        return;
      }
      if (!takeHelloSlot(ip)) {
        sendError('RATE_LIMITED', 'too many authentication attempts', message.id, true);
        socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'authentication rate limit exceeded');
        return;
      }
      // A hello that passes the attempt limiter starts asynchronous token
      // validation. The authenticator may satisfy hello/resume from cache.
      helloInFlight = true;
      if (helloTimer !== null) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }

      const token = message.payload.auth.jellyfinToken;
      let user: JellyfinUser | null;
      try {
        user = await authenticator.validateToken(token);
      } catch {
        logger.warn('jellyfin token validation unavailable');
        sendError(
          'AUTH_UNAVAILABLE',
          'token validation is temporarily unavailable',
          message.id,
          true,
        );
        socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'token validation unavailable');
        return;
      }
      if (socket.readyState !== socket.OPEN) return;
      if (user === null) {
        sendError('AUTH_FAILED', 'Jellyfin rejected the access token', message.id);
        socket.close(WS_CLOSE_CODES.AUTH_FAILED, 'authentication failed');
        return;
      }

      const now = clock();
      if (message.payload.resume !== undefined) {
        const resumed = resumableSession(message.payload.resume, user, now);
        if (resumed === null) {
          sendError(
            'SESSION_RESUME_FAILED',
            'resume token/user mismatch or grace period elapsed',
            message.id,
          );
          // The client proceeds as a fresh session: allow another hello.
          helloInFlight = false;
          armHelloTimer();
          return;
        }
        if (resumed.socket !== null && resumed.socket !== socket) {
          const replaced = resumed.socket;
          resumed.socket = null;
          replaced.close(WS_CLOSE_CODES.SESSION_REPLACED, 'session resumed from a new connection');
        }
        if (resumed.cleanupTimer !== null) {
          clearTimeout(resumed.cleanupTimer);
          resumed.cleanupTimer = null;
        }
        resumed.socket = socket;
        resumed.disconnectedAt = null;
        resumed.backloggedSince = null;
        resumed.lastSeenAt = now;
        resumed.lastValidatedAt = now;
        resumed.updateJellyfinToken(token);
        resumed.userName = user.userName;
        resumed.maturityCeiling = user.maturityCeiling;
        resumed.deviceName = message.payload.client.deviceName ?? null;
        session = resumed;
        releasePending();
        // The limit is on asking Jellyfin about credentials that turn out to be garbage; a hello
        // that authenticated gives its attempt back, so a household behind one address
        // reconnecting at once after a restart cannot lock itself out (security review H3).
        helloLimiter.refund(ip);
        const room = manager.handleResume(resumed.sessionId);
        sendWelcome(resumed, message.id, true, room);
        logger.info({ sessionId: resumed.sessionId }, 'session resumed');
        // Seed the reconnected client's lobby with the roster it may see.
        await sendSeededLobby(resumed, token);
        return;
      }

      // Registry growth is bounded: one valid account (or a token replayed in
      // parallel) must not be able to mint unlimited concurrent sessions.
      if (registry.size() >= config.maxSessions) {
        sendError('RATE_LIMITED', 'the server is at capacity', message.id, true);
        socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'session capacity reached');
        return;
      }
      // There is intentionally no await between this proven-user count and
      // create: concurrent validations serialize here on the JS event loop.
      //
      // `countForUser` counts every session, including the ones waiting out `reconnectGraceMs`
      // with no socket on them, so free those before refusing: a user at the cap is otherwise
      // locked out by their own dropped connections for a full minute, which turns a cap on
      // concurrent *connections* into a cap of ten new connections per minute — and a relay
      // restart or a backoff storm across a household reaches it. `../liveness.ts` states the
      // judgement; `RoomManager.joinRoom` makes the same one about a held seat.
      while (registry.countForUser(user.userId) >= config.maxSessionsPerUser) {
        const detached = registry.oldestDetachedForUser(user.userId);
        if (detached === undefined) break;
        if (detached.cleanupTimer !== null) {
          clearTimeout(detached.cleanupTimer);
          detached.cleanupTimer = null;
        }
        // Exactly what the grace timer would have done, only sooner: the room seat goes with the
        // session, so this cannot leave a ghost in somebody's roster.
        manager.destroySession(detached.sessionId);
        registry.delete(detached.sessionId);
        logger.info(
          { sessionId: detached.sessionId },
          'expired a socket-less session early to admit a new connection for the same user',
        );
      }
      if (registry.countForUser(user.userId) >= config.maxSessionsPerUser) {
        sendError('RATE_LIMITED', 'too many concurrent sessions for this user', message.id, true);
        socket.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'per-user session limit reached');
        return;
      }

      const fresh = registry.create(user, token);
      fresh.socket = socket;
      fresh.lastSeenAt = now;
      fresh.deviceName = message.payload.client.deviceName ?? null;
      session = fresh;
      releasePending();
      helloLimiter.refund(ip);
      sendWelcome(fresh, message.id, false, null);
      logger.info({ sessionId: fresh.sessionId }, 'session established');
      // Give the freshly-welcomed client the roster it may see, so its lobby is
      // populated without waiting for the next open-party change.
      await sendSeededLobby(fresh, token);
    };

    socket.on('message', (data, isBinary) => {
      const current = session;
      if (current !== null) {
        current.lastSeenAt = clock();
        router.handleMessage(current, data, isBinary);
        return;
      }
      void handleHello(data, isBinary);
    });

    armHelloTimer();
  };

  const revalidate = (target: Session, socket: WebSocket): void => {
    void authenticator
      .validateToken(target.currentJellyfinToken(), { forceRefresh: true })
      .then((user) => {
        if (target.socket !== socket) return;
        if (user !== null && user.userId === target.userId) {
          target.userName = user.userName;
          // Like the name: the session's copy follows Jellyfin. A seat already
          // taken keeps the ceiling it was taken with (the maturity rule: a ceiling edited
          // mid-party changes nothing for the seated participant); the next
          // seat this session takes reads the current one.
          target.maturityCeiling = user.maturityCeiling;
          return;
        }
        sendFrame(
          socket,
          JSON.stringify(
            createServerMessage(
              'error',
              {
                code: 'AUTH_EXPIRED',
                message:
                  user === null
                    ? 'Jellyfin token is no longer valid'
                    : 'Jellyfin token identity changed; sign in again',
                retryable: false,
              },
              { sentAt: clock() },
            ),
          ),
          {
            droppable: false,
            ...(deps.outboundLimits !== undefined ? { limits: deps.outboundLimits } : {}),
          },
        );
        socket.close(WS_CLOSE_CODES.AUTH_EXPIRED, 'token no longer valid');
        logger.info({ sessionId: target.sessionId }, 'session closed: token revalidation failed');
      })
      .catch(() => {
        // Jellyfin is temporarily unavailable: preserve the session and retry
        // after the next full revalidation interval.
      });
  };

  const softOutboundBytes = (deps.outboundLimits ?? DEFAULT_OUTBOUND_LIMITS).softBytes;
  const sweep = (): void => {
    const now = clock();
    for (const s of registry.all()) {
      const socket = s.socket;
      if (socket === null) continue;
      if (now - s.lastSeenAt > config.syncConfig.clientTimeoutMs) {
        logger.info({ sessionId: s.sessionId }, 'closing silent connection');
        socket.terminate();
        continue;
      }
      // The other half of liveness (security review H2): a client that keeps sending but has
      // stopped reading. `sendFrame` skips superseded snapshots for it past the soft limit, which
      // bounds the queue but would keep the socket open forever; this closes it on the same clock
      // as silence, into the same reconnect grace.
      const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
      if (buffered <= softOutboundBytes) {
        s.backloggedSince = null;
      } else if (s.backloggedSince === null) {
        s.backloggedSince = now;
      } else if (now - s.backloggedSince > config.syncConfig.clientTimeoutMs) {
        logger.warn(
          { sessionId: s.sessionId, buffered },
          'closing a connection that stopped reading',
        );
        s.backloggedSince = null;
        socket.terminate();
        continue;
      }
      if (now - s.lastValidatedAt >= config.tokenRevalidateIntervalMs) {
        s.lastValidatedAt = now;
        revalidate(s, socket);
      }
    }
  };

  return {
    handleConnection,
    start(): void {
      stopped = false;
      if (sweepTimer !== null) return;
      const cadence = Math.min(
        5_000,
        Math.max(250, Math.floor(config.syncConfig.clientTimeoutMs / 4)),
      );
      sweepTimer = setInterval(sweep, cadence);
      sweepTimer.unref();
    },
    stop(): void {
      stopped = true;
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const s of registry.all()) {
        if (s.cleanupTimer !== null) {
          clearTimeout(s.cleanupTimer);
          s.cleanupTimer = null;
        }
      }
    },
    closeAll(code: number, reason: string): void {
      for (const socket of [...openSockets]) {
        socket.close(code, reason);
      }
    },
  };
}
