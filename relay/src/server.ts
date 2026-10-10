import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { join, sep } from 'node:path';
import {
  DISCOVERY_ALG,
  DISCOVERY_MAX_RESPONSE_BYTES,
  DISCOVERY_SCHEMA_VERSION,
  DiscoveryNonceSchema,
  DiscoveryUrlSchema,
  SERVER_CAPABILITIES,
  WS_CLOSE_CODES,
  canonicalDiscoveryBytes,
  createServerMessage,
  formatBrandingMark,
  type DiscoveryUrl,
  type RelayDiscovery,
  type RelayDiscoverySignedFields,
  type ServerMessage,
  type RelayBinding,
} from '@screenfin/protocol';
import { normalizePathPrefix, type AppConfig } from './config';
import {
  MAX_TRACKED_PRE_AUTH_IPS,
  PRE_AUTH_WINDOW_MS,
  capKey,
  clientIp,
  createConnectionLayer,
} from './connection';
import { fsFileStorage, type FileStorage } from './fileStore';
import { isDroppableFrame, sendFrame, type OutboundLimits } from './outbound';
import { createJellyfinAuthenticator, type JellyfinAuthenticator } from './identity';
import { createJellyfinBinding, type JellyfinBinding } from './jellyfinBinding';
import { createFixedWindowLimiter } from './rateLimit';
import { loadOrCreateRelayIdentity, type RelayIdentity } from './relayIdentity';
import { RoomManager } from './rooms/manager';
import { RoomPersistence } from './rooms/persistence';
import { watchEventLoop } from './eventLoopWatch';
import { InMemoryRoomStore } from './rooms/store';
import { MAX_FRAME_BYTES, createRouter } from './router';
import { SessionRegistry } from './sessions';
import { webSecurityHeaders } from './webHeaders';
import {
  DEFAULT_VISIBILITY_TTL_MS,
  createJellyfinItemVisibility,
  type ItemVisibilityWarmer,
} from './visibility';

/**
 * How often a live room's visibility answers are renewed.
 *
 * Derived from the TTL rather than restating it: a second copy of 300 000 in
 * this file is a number that goes stale silently the day the other one moves.
 * Half, so a renewal always lands with at least half an answer's life left —
 * `ItemVisibilityWarmer.refresh` re-asks at the same half-life, and the two
 * together mean an answer under a running party is renewed before it can lapse
 * rather than after it already has.
 */
const VISIBILITY_REFRESH_INTERVAL_MS = DEFAULT_VISIBILITY_TTL_MS / 2;

/**
 * How long a discovery document is good for (PROTOCOL.md § 2.1). Half the
 * protocol's ceiling: the nonce is what defeats replay, so this only has to
 * outlive one client's round trip with room for a slow television.
 */
const DISCOVERY_LIFETIME_S = 30;

/**
 * HTTP-level bounds (security review L7). The supported deployment has a proxy in front that
 * absorbs most of what these guard against; they are for the relay reached directly. A WebSocket
 * is exempt from the idle timeout once upgraded (`ws` clears it), and the liveness sweep owns it.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 60_000;
/** Beyond every session and every pending socket the relay admits, room for plain HTTP. */
const HTTP_CONNECTION_HEADROOM = 1_000;

/**
 * The shortest gap between two lobby pushes (security review H1).
 *
 * Every create, leave, item change, queue edit and host transfer republishes the roster to every
 * connected session, and each push warms the maturity rule's answers for every connected account.
 * Unbounded,
 * one account's create → leave loop sent its own sockets 432 MB of roster in 18 s. The first
 * change in a quiet period still goes out at once; the changes after it inside the window are
 * carried by one push at the window's end, which always describes the roster as it then is.
 */
export const LOBBY_PUSH_MIN_INTERVAL_MS = 250;

export interface BuildServerDeps {
  config: AppConfig;
  clock?: () => number;
  /** Test seam; production is bound to config.jellyfinUrl when omitted. */
  authenticator?: JellyfinAuthenticator;
  /** Test seam; production reads and writes config.roomsPath when omitted. */
  roomStorage?: FileStorage;
  /** Test seam; overrides the trailing-write window for persisted rooms. */
  roomSaveIntervalMs?: number;
  /**
   * Test seam; overrides how often live rooms' visibility answers are renewed
   *. Production derives it from the visibility TTL — see
   * `VISIBILITY_REFRESH_INTERVAL_MS`, which is two and a half minutes and
   * therefore not something a test can wait out.
   */
  visibilityRefreshIntervalMs?: number;
  /** Test seam; production is bound to config.jellyfinUrl when omitted. */
  visibility?: ItemVisibilityWarmer;
  /** Test seam; production reads and writes config.identityPath when omitted. */
  identityStorage?: FileStorage;
  /** Test seam; production reads `/System/Info/Public` on config.jellyfinUrl when omitted. */
  jellyfinBinding?: JellyfinBinding;
  /** Test seam; receives every log line (at `config.logLevel`) instead of stdout. */
  loggerStream?: { write: (line: string) => void };
  /** Test seam; production uses `DEFAULT_OUTBOUND_LIMITS` (security review H2). */
  outboundLimits?: OutboundLimits;
}

export interface SyncServer {
  app: FastifyInstance;
  store: InMemoryRoomStore;
  registry: SessionRegistry;
  manager: RoomManager;
  rooms: RoomPersistence;
  /** The relay's P-256 identity (PROTOCOL.md § 2.1); the private key stays inside it. */
  identity: RelayIdentity;
  /**
   * The binding document naming this relay — the object inside the branding
   * mark an administrator pastes into Jellyfin's Custom CSS (PROTOCOL.md
   * § 2.3); `null` until the Jellyfin `Id` is known. The mark is printed to
   * the boot log the first time it can be, and it is the only form printed:
   * no client reads a `/.well-known/screenfin` file (§ 2.2, Amendment 4).
   */
  brandingDocument: () => RelayBinding | null;
  shutdown: () => Promise<void>;
}

export async function buildServer(deps: BuildServerDeps): Promise<SyncServer> {
  const { config } = deps;
  const clock = deps.clock ?? ((): number => Date.now());
  const authenticator =
    deps.authenticator ??
    createJellyfinAuthenticator({
      jellyfinUrl: config.jellyfinUrl,
      cacheTtlMs: config.tokenValidationCacheTtlMs,
      clock,
    });

  const app = fastify({
    // Honors X-Forwarded-For only as configured (default: never), protecting
    // the pre-auth pending-socket and hello-attempt limits.
    trustProxy: config.trustProxy,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            ...(deps.loggerStream !== undefined ? { stream: deps.loggerStream } : {}),
            // Message payloads are not logged, but redact likely nesting paths
            // so future diagnostic logging cannot expose a Jellyfin token.
            redact: {
              paths: [
                'req.headers.authorization',
                'jellyfinToken',
                'auth.jellyfinToken',
                'payload.auth.jellyfinToken',
                'message.payload.auth.jellyfinToken',
                'msg.payload.auth.jellyfinToken',
                'req.body.payload.auth.jellyfinToken',
                '*.auth.jellyfinToken',
                '*.payload.auth.jellyfinToken',
              ],
              censor: '[redacted]',
            },
          },
  });
  app.server.maxConnections =
    config.maxSessions + config.maxPendingSockets + HTTP_CONNECTION_HEADROOM;
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_FRAME_BYTES } });

  // Security review M3: nosniff and a referrer policy on everything; on the web client's HTML, a
  // CSP and a frame ban. Computed once, from the bundle as it is on disk at boot.
  const securityHeaders = webSecurityHeaders(config.webRoot);
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.headers(securityHeaders.all);
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) {
      void reply.headers(securityHeaders.html);
    }
    return payload;
  });

  // Security review H3. With TRUST_PROXY unset, a proxy in front makes every client arrive from
  // the proxy's address, and every per-address pre-auth limit becomes one bucket for everybody.
  // A forwarded header arriving under that policy is exactly that misconfiguration, so say so —
  // once, since the header will be on every request.
  let forwardedWarned = false;
  if (config.trustProxy === false) {
    app.addHook('onRequest', async (request) => {
      if (forwardedWarned || request.headers['x-forwarded-for'] === undefined) return;
      forwardedWarned = true;
      app.log.warn(
        { peer: request.socket.remoteAddress },
        'X-Forwarded-For arrived but TRUST_PROXY is unset, so every client behind that proxy ' +
          'shares its address for the unauthenticated connection, hello and discovery limits. ' +
          "Set TRUST_PROXY to the proxy's address (or CIDR) — see the deployment docs.",
      );
    });
  }

  // Who this relay is, and which Jellyfin it belongs to (PROTOCOL.md § 2.1).
  // The key is read before anything listens so the boot log states the
  // fingerprint and short code once, in order, where an operator will look.
  const identity = loadOrCreateRelayIdentity({
    path: config.identityPath,
    storage: deps.identityStorage ?? fsFileStorage,
    logger: app.log,
  });
  const binding =
    deps.jellyfinBinding ??
    createJellyfinBinding({ jellyfinUrl: config.jellyfinUrl, clock, logger: app.log });

  const store = new InMemoryRoomStore();
  const registry = new SessionRegistry(clock);
  // The maturity rule's oracle. Bound to the same immutable, operator-controlled Jellyfin as
  // the authenticator, and it asks with each user's own token — never a service
  // credential (the relay's outbound-request security boundary).
  const visibility: ItemVisibilityWarmer =
    deps.visibility ??
    createJellyfinItemVisibility({
      jellyfinUrl: config.jellyfinUrl,
      clock,
      logger: app.log,
      // Answers under a room are evicted last (security review M1). Reads `manager` only after
      // initialization, like `pushLobby`.
      pinnedItemIds: (): string[] => manager.itemIdsInRooms(),
    });

  const outboundLimits = deps.outboundLimits;
  const sendRaw = (participantId: string, frame: string, droppable: boolean): void => {
    const socket = registry.get(participantId)?.socket;
    if (socket == null) return;
    const outcome = sendFrame(socket, frame, {
      droppable,
      ...(outboundLimits !== undefined ? { limits: outboundLimits } : {}),
    });
    if (outcome === 'terminated') {
      app.log.warn(
        { sessionId: participantId },
        'closed a connection that stopped reading: its outbound queue passed the limit',
      );
    }
  };
  const sendTo = (participantId: string, message: ServerMessage): void => {
    // Only ever an answer to that participant (a `room.stateRequest`) or the one `room.removed`
    // that tells it why it lost its seat, so never skipped.
    sendRaw(participantId, JSON.stringify(message), false);
  };
  // One serialization per broadcast, not one per recipient: the frame is
  // identical for everyone, and JSON.stringify of a full room snapshot was by
  // far the most expensive thing the relay did per participant. Serializing
  // here and synchronously is also what lets RoomManager broadcast live room
  // state without cloning it first.
  const broadcast = (roomId: string, message: ServerMessage, opts?: { except?: string }): void => {
    const room = store.get(roomId);
    if (room === undefined) return;
    const frame = JSON.stringify(message);
    const droppable = isDroppableFrame(message.type);
    for (const participant of room.state.participants) {
      if (participant.participantId === opts?.except) continue;
      // A `reconnecting` seat has no socket in this room. A dropped one has none at all, but a host
      // who left keeps theirs — and may already be in another room on it, where this
      // room's frames would read as that room's.
      if (participant.connection === 'reconnecting') continue;
      sendRaw(participant.participantId, frame, droppable);
    }
  };
  /**
   * Push the open-party roster to every connected session, **as that session's
   * account may see it**.
   *
   * One serialization per distinct Jellyfin account rather than one for the
   * whole relay: two sessions of the same user necessarily get the same roster,
   * and two different users may not. A household is a handful of accounts, so
   * this is a handful of frames rather than the one it used to be — and it is
   * still one per account, not one per socket.
   *
   * Reads `manager` only after initialization.
   */
  const pushLobby = (): void => {
    const sentAt = clock();
    const framesByUser = new Map<string, string>();
    for (const s of registry.all()) {
      if (!s.socket) continue;
      let frame = framesByUser.get(s.userId);
      if (frame === undefined) {
        frame = JSON.stringify(
          createServerMessage('lobby.state', { groups: manager.lobbyFor(s.userId) }, { sentAt }),
        );
        framesByUser.set(s.userId, frame);
      }
      sendRaw(s.sessionId, frame, true);
    }
  };

  /**
   * Resolve, for every connected account, anything the rooms now hold that the
   * cache does not know about yet. Resolves true when something landed.
   *
   * This is the second of the maturity rule's two warm points: the room item set has just
   * changed, and the roster that describes it is about to go out. The push
   * happens first regardless, because a lobby that waits for Jellyfin is a lobby
   * that a slow Jellyfin can stall entirely.
   */
  const warmLobbyVisibility = async (): Promise<boolean> => {
    const itemIds = manager.itemIdsInRooms();
    if (itemIds.length === 0) return false;
    const asked = new Set<string>();
    const warms: Array<Promise<boolean>> = [];
    for (const s of registry.all()) {
      if (!s.socket || asked.has(s.userId)) continue;
      asked.add(s.userId);
      warms.push(visibility.warm(s.userId, s.currentJellyfinToken(), itemIds));
    }
    return (await Promise.all(warms)).some(Boolean);
  };

  const publishLobby = (): void => {
    lobbyPushedAt = clock();
    pushLobby();
    // Re-push only when the warm actually learned something, and through
    // `pushLobby` rather than `broadcastLobby`, so a warm can never schedule
    // another warm.
    void warmLobbyVisibility().then(
      (learned) => {
        if (learned) pushLobby();
        // The same warm may have brought a room its first rating, or the
        // ladder that names a seated ceiling: a
        // join stamped `7` before the ladder landed reads `TV-Y7` the moment it
        // does, rather than at the next presence flush. Cheap by construction
        // — only a pair that moved is broadcast — and it cannot recurse, because
        // `mutate` republishes the room, never the lobby.
        manager.refreshRoomMaturity();
      },
      (err: unknown) => {
        app.log.warn({ err }, 'lobby visibility warm failed');
      },
    );
  };

  let lobbyPushedAt = Number.NEGATIVE_INFINITY;
  let lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * `publishLobby`, at most once per `LOBBY_PUSH_MIN_INTERVAL_MS`: at once when the roster has
   * been quiet, otherwise once at the end of the window. Synchronous by signature, like every
   * `RoomManagerDeps` callback.
   */
  const broadcastLobby = (): void => {
    if (lobbyTimer !== null) return;
    const wait = lobbyPushedAt + LOBBY_PUSH_MIN_INTERVAL_MS - clock();
    if (wait <= 0) {
      publishLobby();
      return;
    }
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      publishLobby();
    }, wait);
    lobbyTimer.unref();
  };
  const stopLobbyPushes = (): void => {
    if (lobbyTimer === null) return;
    clearTimeout(lobbyTimer);
    lobbyTimer = null;
  };

  /**
   * One live token per account, preferring a session that still has a socket.
   *
   * A session inside its reconnect grace has no socket and is still a real seat
   * the add door counts, so its token is still the right — and only —
   * way to ask Jellyfin about that person. `warmLobbyVisibility` skips those
   * because it is about to *send* something and there is nowhere to send it;
   * this is about asking, which needs no socket.
   */
  const tokensForUsers = (userIds: readonly string[]): Map<string, string> => {
    const wanted = new Set(userIds);
    const tokens = new Map<string, string>();
    for (const s of registry.all()) {
      if (!wanted.has(s.userId)) continue;
      if (s.socket === null && tokens.has(s.userId)) continue;
      tokens.set(s.userId, s.currentJellyfinToken());
      if (s.socket !== null) wanted.delete(s.userId);
    }
    return tokens;
  };

  /**
   * The maturity rule's **third** warm point: a guard that had to refuse for want of an
   * answer, asking for the one it lacked.
   *
   * The other two fire on session welcome and on a room's item set having
   * already changed, and neither can cover the add door, because **the add is
   * what changes the item set** — so the answer used to arrive after the
   * decision it was needed for, which is why that door failed open on first
   * contact with an item, every time. Now the door refuses retryably and starts
   * the question here, so the same press a second later is decided.
   *
   * Synchronous by signature, exactly like `broadcastLobby`: `router.ts` has no
   * `await` in it and must keep none.
   */
  const requestVisibility = (userIds: readonly string[], itemIds: readonly string[]): void => {
    if (itemIds.length === 0) return;
    for (const [userId, token] of tokensForUsers(userIds)) {
      void visibility.warm(userId, token, itemIds).then(
        (learned) => {
          // The rail can look different now, and so can a room's stamp: an item
          // resolved for the first time brings its rating with it.
          if (learned) pushLobby();
          manager.refreshRoomMaturity();
        },
        (err: unknown) => {
          app.log.warn({ err, userId }, 'guard visibility warm failed');
        },
      );
    }
  };

  /**
   * Keep the answers under every live room fresh, and re-stamp the rooms whose
   * maturity that changes.
   *
   * `warm` never re-asks about an id it already holds an answer for, which is
   * right for a lobby push and wrong for a party nobody is joining: measured, a running room's
   * `maturityRating` went from `'G'` to `null` 168 s
   * in and stayed there, because the entries simply expired and `summarize`
   * skips an expired rating. `refresh` renews an answer past its half-life, and
   * `refreshRoomMaturity` broadcasts only the rooms whose pair actually moved.
   */
  const refreshRoomVisibility = async (): Promise<void> => {
    const itemIds = manager.itemIdsInRooms();
    if (itemIds.length === 0) return;
    const asked = new Set<string>();
    const refreshes: Array<Promise<boolean>> = [];
    for (const s of registry.all()) {
      if (!s.socket || asked.has(s.userId)) continue;
      asked.add(s.userId);
      refreshes.push(visibility.refresh(s.userId, s.currentJellyfinToken(), itemIds));
    }
    if (refreshes.length === 0) return;
    const learned = (await Promise.all(refreshes)).some(Boolean);
    // Unconditional: an answer can be unchanged while the rating that rode in
    // with it has been renewed, which is the whole point of the refresh.
    manager.refreshRoomMaturity();
    if (learned) pushLobby();
  };

  let visibilityRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const startVisibilityRefresh = (): void => {
    if (visibilityRefreshTimer !== null) return;
    visibilityRefreshTimer = setInterval(() => {
      void refreshRoomVisibility().catch((err: unknown) => {
        app.log.warn({ err }, 'room visibility refresh failed');
      });
    }, deps.visibilityRefreshIntervalMs ?? VISIBILITY_REFRESH_INTERVAL_MS);
    // Like the connection layer's sweep: a periodic chore must never be the
    // reason the process stays up.
    visibilityRefreshTimer.unref();
  };
  const stopVisibilityRefresh = (): void => {
    if (visibilityRefreshTimer === null) return;
    clearInterval(visibilityRefreshTimer);
    visibilityRefreshTimer = null;
  };

  // Rooms outlive the process (ROADMAP.md phase 5): a restart to pick up a new
  // image should interrupt a party, not end it.
  const rooms = new RoomPersistence({
    path: config.roomsPath,
    storage: deps.roomStorage ?? fsFileStorage,
    store,
    clock,
    setTimer: (fn, delayMs) => setTimeout(fn, delayMs).unref(),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(deps.roomSaveIntervalMs !== undefined ? { saveIntervalMs: deps.roomSaveIntervalMs } : {}),
    logger: app.log,
  });

  const manager = new RoomManager({
    store,
    clock,
    setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    syncConfig: config.syncConfig,
    // The operator's, from the environment (PROTOCOL.md § 8.2).
    maxParticipants: config.maxRoomParticipants,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    stalledSeatRemoveMs: config.stalledSeatRemoveMs,
    // The operator's caps (security review H1); the rates beside them are the manager's defaults.
    limits: { maxRooms: config.maxRooms, maxRoomsPerUser: config.maxRoomsPerUser },
    broadcast,
    sendTo,
    broadcastLobby,
    requestVisibility,
    persist: () => rooms.markDirty(),
    visibility,
  });
  const restored = manager.restore(rooms.load());
  if (restored > 0) app.log.info({ rooms: restored }, 'restored persisted rooms');
  const router = createRouter({
    manager,
    clock,
    logger: app.log,
    ...(outboundLimits !== undefined ? { outboundLimits } : {}),
  });
  const connections = createConnectionLayer({
    config,
    authenticator,
    registry,
    manager,
    router,
    clock,
    logger: app.log,
    visibility,
    identity,
    binding,
    ...(outboundLimits !== undefined ? { outboundLimits } : {}),
  });

  if (config.allowedOrigins.length === 0) {
    app.log.warn('ALLOWED_ORIGINS is empty: websocket connections are accepted from any origin');
  }
  if (config.trustProxy === true) {
    app.log.warn(
      'TRUST_PROXY=true trusts every hop, so X-Forwarded-For is client-controlled and the ' +
        'pending-socket and hello rate limits can be bypassed. Prefer an IP/CIDR list naming ' +
        'your own proxy.',
    );
  }

  // Every route lives under BASE_PATH: `''` at the root, or a prefix a
  // non-stripping proxy forwards whole. A stripping proxy keeps this empty and
  // reports the prefix it removed in `X-Forwarded-Prefix` instead (below).
  const base = config.basePath;

  // `/healthz` deliberately says nothing about identity: the short code must
  // reach a client from the operator, never from the candidate (§ 16).
  //
  // Nor, to anybody else, about activity (security review L6): the counts told anyone polling
  // it when a household is watching. They stay for a caller on this machine — the container's
  // own healthcheck, an operator's `curl`, a local dev proxy — which is a loopback peer with no
  // forwarded header; a proxy on the same host forwarding somebody else is not this host asking.
  const isLocalCaller = (request: FastifyRequest): boolean => {
    const peer = request.socket.remoteAddress ?? '';
    const loopback = peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
    return loopback && request.headers['x-forwarded-for'] === undefined;
  };
  app.get(`${base}/healthz`, (request) =>
    isLocalCaller(request)
      ? { status: 'ok', rooms: store.size(), sessions: registry.size() }
      : { status: 'ok' },
  );

  /**
   * The prefix a stripping proxy removed before forwarding, if one is trusted
   * to say so. Read only when `trustProxy` is set at all — the same switch that
   * lets `X-Forwarded-Proto` and `X-Forwarded-Host` be believed — and only in
   * the shape BASE_PATH itself accepts, so nothing else ever gets signed. Like
   * `Host`, a forged value here can only mislead the client that sent it: the
   * response is `no-store` and bound to that client's nonce.
   */
  const forwardedPrefix = (request: FastifyRequest): string => {
    if (config.trustProxy === false) return '';
    const header = request.headers['x-forwarded-prefix'];
    if (typeof header !== 'string') return '';
    return normalizePathPrefix(header) ?? '';
  };

  /**
   * The `/v1/ws` URLs the signed document names. Operator-configured when set;
   * otherwise exactly the address this request arrived on — `request.protocol`
   * and `request.host` honour `X-Forwarded-Proto` / `X-Forwarded-Host` only
   * under the configured `trustProxy`, the same policy as every per-address
   * limit — plus any trusted forwarded prefix and the relay's own base path,
   * in that order. A derived URL can therefore only ever name the host the
   * requester already used, so a forged `Host` header signs something for its
   * sender alone; the response is `no-store` and nonce-bound, so it reaches
   * nobody else.
   */
  const advertisedUrls = (request: FastifyRequest): DiscoveryUrl[] => {
    if (config.advertisedUrls.length > 0) {
      return config.advertisedUrls.map((url, priority) => ({ url, priority }));
    }
    const scheme = request.protocol === 'https' ? 'wss' : 'ws';
    const derived = DiscoveryUrlSchema.safeParse({
      url: `${scheme}://${request.host}${forwardedPrefix(request)}${base}/v1/ws`,
      priority: 0,
    });
    return derived.success ? [derived.data] : [];
  };

  /**
   * The binding document (PROTOCOL.md § 2.3): what an administrator pastes
   * into Jellyfin's Custom CSS as the branding mark. The URLs are
   * ADVERTISED_URLS when set; otherwise a derived URL depends on the request,
   * so the document carries a placeholder the operator fills in. Never the
   * short code: this is the key, in public, and the code is only ever an
   * out-of-band check.
   */
  const brandingDocument = (): RelayBinding | null => {
    const jellyfinServerId = binding.current();
    if (jellyfinServerId === null) return null;
    const urls =
      config.advertisedUrls.length > 0
        ? config.advertisedUrls.map((url, priority) => ({ url, priority }))
        : [{ url: `wss://<your-relay-host>${base}/v1/ws`, priority: 0 }];
    return {
      schema: DISCOVERY_SCHEMA_VERSION,
      jellyfinServerId,
      relays: [{ relayId: identity.relayId, publicKey: identity.publicKey, urls }],
    };
  };
  let markLogged = false;
  const logBrandingMark = (): void => {
    if (markLogged) return;
    const document = brandingDocument();
    if (document === null) return;
    markLogged = true;
    const placeholder = config.advertisedUrls.length === 0;
    // The branding mark — the pairing, and the only one (§ 2.3, Amendment 4):
    // one line an administrator pastes into Jellyfin, which every client then
    // reads anonymously; no proxy, nothing typed, and the relay writes nothing.
    // A string field: the raw JSON log line escapes its quotes, so the exact
    // text is `… | grep brandingMark | tail -1 | jq -r .brandingMark`.
    app.log.info(
      { brandingMark: formatBrandingMark(document) },
      `To pair every client with this relay, paste the brandingMark line of this log entry ` +
        `(jq -r .brandingMark) at the end of Dashboard → General → Branding → Custom CSS ` +
        `on your Jellyfin, then save` +
        (placeholder
          ? ' — after setting ADVERTISED_URLS: this line carries a placeholder relay URL'
          : ''),
    );
    if (config.logLevel !== 'silent') {
      (deps.loggerStream ?? process.stdout).write(
        brandingMarkBanner(formatBrandingMark(document), placeholder),
      );
    }
  };
  const discoveryLimiter = createFixedWindowLimiter({
    clock,
    windowMs: PRE_AUTH_WINDOW_MS,
    limit: config.discoveryRateLimitPerIp,
    maxTracked: MAX_TRACKED_PRE_AUTH_IPS,
  });

  // Signed discovery (PROTOCOL.md § 2.1). Plain HTTP beside the socket, not
  // inside it: nothing here touches the router or a room, and the one await —
  // asking Jellyfin for its Id when it is still unknown — is admission-time
  // work of exactly the kind the hello already does.
  app.get(`${base}/v1/discovery`, async (request, reply) => {
    void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    if (!discoveryLimiter.take(capKey(clientIp(request)))) {
      return reply.code(429).send({ error: 'RATE_LIMITED' });
    }
    const nonce = DiscoveryNonceSchema.safeParse((request.query as { nonce?: unknown }).nonce);
    if (!nonce.success) {
      return reply.code(400).send({ error: 'INVALID_NONCE' });
    }
    const urls = advertisedUrls(request);
    if (urls.length === 0) {
      // Only reachable when the request carried no usable Host and nothing is
      // configured; a document with no URL is nothing a client can act on.
      return reply.code(503).send({ error: 'NO_ADVERTISED_URL' });
    }
    const jellyfinServerId = binding.current() ?? (await binding.ensure());
    const iat = Math.floor(clock() / 1000);
    const fields: RelayDiscoverySignedFields = {
      schema: DISCOVERY_SCHEMA_VERSION,
      alg: DISCOVERY_ALG,
      nonce: nonce.data,
      relayId: identity.relayId,
      publicKey: identity.publicKey,
      jellyfinServerId,
      urls,
      capabilities: [...SERVER_CAPABILITIES],
      iat,
      exp: iat + DISCOVERY_LIFETIME_S,
    };
    const document: RelayDiscovery = {
      ...fields,
      signature: identity.sign(canonicalDiscoveryBytes(fields)).toString('base64url'),
    };
    // The last line behind the boot-time bound on ADVERTISED_URLS: a client
    // stops reading at DISCOVERY_MAX_RESPONSE_BYTES, so a document past it is
    // one no client can verify, and better refused here than truncated there.
    const body = JSON.stringify(document);
    if (Buffer.byteLength(body) > DISCOVERY_MAX_RESPONSE_BYTES) {
      app.log.error(
        { bytes: Buffer.byteLength(body) },
        'discovery document exceeds the client read limit; shorten ADVERTISED_URLS',
      );
      return reply.code(500).send({ error: 'DOCUMENT_TOO_LARGE' });
    }
    return reply.type('application/json; charset=utf-8').send(body);
  });

  app.get(`${base}/v1/ws`, { websocket: true }, (socket, request) => {
    connections.handleConnection(socket, request);
  });

  // The web client, when this process carries one (WEB_ROOT): the
  // `screenfin-server` image is the relay and the client in one container on
  // one port, so a proxy forwards one hostname and the client's derived
  // `<page origin>/v1/ws` is this socket by construction. The rules are the
  // ones the nginx image used to state: the entry point is revalidated on
  // every load so a redeploy takes effect at once, Vite's content-hashed
  // `assets/` are immutable, and any other GET under the base that names no
  // file is a client-side route and gets `index.html` — except a relay path,
  // which is a 404 like it always was. Unset, none of this is registered and
  // the relay is the API-only process the published source builds.
  if (config.webRoot !== null) {
    const webRoot = config.webRoot;
    const assetsDir = join(webRoot, 'assets') + sep;
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: `${base}/`,
      index: ['index.html'],
      // The plugin's own cache-control would win over `setHeaders`; the policy
      // is stated once, below, for the files it sends and for the fallback.
      cacheControl: false,
      setHeaders: (reply, path) => {
        void reply.header(
          'cache-control',
          path.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      const rel =
        base === ''
          ? path
          : path === base
            ? '/'
            : path.startsWith(`${base}/`)
              ? path.slice(base.length)
              : null;
      const isRead = request.method === 'GET' || request.method === 'HEAD';
      const isRelayPath =
        rel === null || rel === '/v1' || rel.startsWith('/v1/') || rel === '/healthz';
      const isMissingAsset = rel !== null && rel.startsWith('/assets/');
      if (isRead && !isRelayPath && !isMissingAsset) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
    app.log.info({ webRoot, base: base === '' ? '/' : base }, 'serving the web client');
  }

  // The mark is printed the first time the Id is known, whichever read learned
  // it — the boot read, the hourly one, or a discovery request while Jellyfin
  // was down at boot and has since recovered.
  binding.onBound(() => logBrandingMark());
  // And once now, in case the binding already knows (an injected one can);
  // the logger is idempotent, so a transition after this prints nothing twice.
  logBrandingMark();

  let stopEventLoopWatch: (() => void) | null = null;
  app.addHook('onReady', async () => {
    connections.start();
    stopEventLoopWatch ??= watchEventLoop(app.log);
    startVisibilityRefresh();
    // Boot never waits on Jellyfin (config.ts); the Id arrives when it arrives.
    void binding.refresh();
    binding.start();
  });
  app.addHook('onClose', async () => {
    stopEventLoopWatch?.();
    stopEventLoopWatch = null;
    connections.stop();
    stopLobbyPushes();
    stopVisibilityRefresh();
    binding.stop();
  });

  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    // Save the parties rather than end them: clients see an ordinary
    // disconnect, reconnect with their usual backoff, and rejoin the room they
    // were in. Only if the save fails is the party genuinely over, and then
    // saying so beats leaving every client to reconnect into a room that will
    // not be there.
    rooms.markDirty();
    if (!rooms.flush()) {
      manager.closeAllRooms(); // room.closed {reason: "server-shutdown"} to every room
    }
    manager.stopTimers();
    stopLobbyPushes();
    rooms.stop();
    stopVisibilityRefresh();
    binding.stop();
    connections.closeAll(WS_CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
    connections.stop();
    await app.close();
  };

  return {
    app,
    store,
    registry,
    manager,
    rooms,
    identity,
    brandingDocument,
    shutdown,
  };
}

const BANNER_RULE = '━'.repeat(72);

/**
 * The same mark again, for the person reading `docker compose logs`: the JSON entry above is what a
 * script greps, and a 400-character escaped string in the middle of it is hard to find and harder
 * to copy. The mark sits alone on its own line, unprefixed and unindented, so selecting that line
 * is selecting exactly what Jellyfin needs.
 */
export function brandingMarkBanner(mark: string, placeholder: boolean): string {
  return [
    '',
    BANNER_RULE,
    '  SCREENFIN BRANDING MARK',
    '',
    '  Paste the line below at the end of your Jellyfin server’s',
    '  Dashboard → General → Branding → Custom CSS, then save.',
    '  Screenfin clients read it there to find and trust this relay.',
    ...(placeholder
      ? [
          '',
          '  First set ADVERTISED_URLS: this mark carries a placeholder address',
          '  (<your-relay-host>) that no client can reach.',
        ]
      : []),
    '',
    mark,
    '',
    BANNER_RULE,
    '',
    '',
  ].join('\n');
}
