import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_SYNC_CONFIG,
  DISCOVERY_MAX_RESPONSE_BYTES,
  DiscoveryUrlSchema,
  MAX_DISCOVERY_URLS,
  MAX_DISCOVERY_URLS_JSON_BYTES,
  MAX_DISCOVERY_URL_LENGTH,
  MAX_ROOM_PARTICIPANTS_LIMIT,
  SyncConfigSchema,
  type SyncConfig,
} from '@screenfin/protocol';
import { MAX_PERSISTED_ROOMS } from './rooms/persistence';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const intVar = (min: number) => z.coerce.number().int().min(min);

/**
 * Validate and normalize the one operator-controlled Jellyfin request base.
 * This is syntactic only: startup must not depend on Jellyfin being reachable.
 */
function parseJellyfinUrl(raw: string): string {
  // WHATWG URL normalizes a bare trailing `?`/`#` to an empty search/hash, so
  // reject delimiters from the operator input before parsing as well.
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('Invalid JELLYFIN_URL: query strings and fragments are not allowed');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid JELLYFIN_URL: expected an absolute http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid JELLYFIN_URL: URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Invalid JELLYFIN_URL: embedded credentials are not allowed');
  }
  const pathPrefix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathPrefix}`;
}

/**
 * Validate and normalise the operator's ADVERTISED_URLS: the `/v1/ws` addresses
 * the discovery document names (PROTOCOL.md § 2.1). Every entry is signed and
 * handed to clients as "connect here", and a client accepts a document only
 * when the URL it is about to open is in the list **by string equality** — so
 * each entry must be exactly the socket, written as a client would derive it:
 * `ws(s)://host[:port][/base]/v1/ws`, lower-case scheme and host, no default
 * port, no userinfo, no query, no fragment. The list is also bounded so the
 * signed document always fits the 16 KiB a client reads.
 */
function parseAdvertisedUrls(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > MAX_DISCOVERY_URLS) {
    throw new Error(`Invalid ADVERTISED_URLS: at most ${MAX_DISCOVERY_URLS} URLs`);
  }
  const normalized = entries.map((entry) => {
    if (entry.length > MAX_DISCOVERY_URL_LENGTH) {
      throw new Error(
        `Invalid ADVERTISED_URLS: an entry is longer than ${MAX_DISCOVERY_URL_LENGTH} characters`,
      );
    }
    if (entry.includes('?') || entry.includes('#')) {
      throw new Error(
        `Invalid ADVERTISED_URLS: "${entry}" carries a query or fragment; advertise only the socket`,
      );
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`Invalid ADVERTISED_URLS: "${entry}" is not an absolute URL`);
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`Invalid ADVERTISED_URLS: "${entry}" must use ws or wss`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('Invalid ADVERTISED_URLS: embedded credentials are not allowed');
    }
    if (!url.pathname.endsWith('/v1/ws') || url.pathname.includes('//')) {
      throw new Error(
        `Invalid ADVERTISED_URLS: "${entry}" must end in /v1/ws (a base path before it is fine)`,
      );
    }
    // WHATWG normalisation: lower-case scheme and host, default port dropped,
    // percent-encoding canonical — the form a client derives from its own base.
    const canonical = `${url.protocol}//${url.host}${url.pathname}`;
    if (!DiscoveryUrlSchema.shape.url.safeParse(canonical).success) {
      throw new Error(`Invalid ADVERTISED_URLS: "${entry}" is not an advertisable URL`);
    }
    return canonical;
  });
  const serialized = Buffer.byteLength(
    JSON.stringify(normalized.map((url, priority) => ({ url, priority }))),
  );
  if (serialized > MAX_DISCOVERY_URLS_JSON_BYTES) {
    throw new Error(
      `Invalid ADVERTISED_URLS: the list serialises to ${serialized} bytes; keep it under ` +
        `${MAX_DISCOVERY_URLS_JSON_BYTES} so the signed discovery document stays inside the ` +
        `${DISCOVERY_MAX_RESPONSE_BYTES}-byte limit clients read`,
    );
  }
  return normalized;
}

/**
 * A path prefix as the relay mounts or advertises it: `''` for the root,
 * otherwise `/segment(/segment)*` with no trailing slash. Shared by BASE_PATH
 * (the relay's own mount, `parseBasePath`) and by the `X-Forwarded-Prefix` a
 * trusted stripping proxy reports (`server.ts`), so both say the same thing
 * about what a client-visible path looks like. `null` when the input is not
 * that shape.
 */
export function normalizePathPrefix(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '';
  if (trimmed.length > 512) return null;
  const withoutTrailing = trimmed.replace(/\/+$/, '');
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(withoutTrailing)) return null;
  if (withoutTrailing.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return withoutTrailing;
}

/**
 * Where the relay mounts its routes. Empty means the root, as before;
 * `/screenfin` means `/screenfin/healthz`, `/screenfin/v1/ws` and
 * `/screenfin/v1/discovery`, for a proxy that forwards the path unstripped.
 */
function parseBasePath(raw: string): string {
  const prefix = normalizePathPrefix(raw);
  if (prefix === null) {
    throw new Error(
      'Invalid BASE_PATH: expected an absolute path of plain segments such as /screenfin',
    );
  }
  return prefix;
}

/**
 * Parse TRUST_PROXY into a Fastify `trustProxy` value.
 *
 * This gates whether `X-Forwarded-For` is honored at all. It matters because the
 * pre-authentication socket and hello-attempt limits key on client address, so a
 * spoofable address means those limits do not provide useful protection.
 * Deliberately parsed explicitly rather than with `z.coerce.boolean()`, because
 * `Boolean('false') === true` — an operator writing TRUST_PROXY=false to be safe
 * would silently get the most permissive setting.
 *
 *   unset/''/'false'/'0' -> false  (default: XFF ignored, use the socket peer)
 *   '<n>'                -> error  (a hop count cannot authenticate the connecting proxy)
 *   'true'               -> true   (trust ALL hops — see the startup warning)
 *   'a,b/24'             -> list   (trust these addresses/CIDRs only)
 */
function parseTrustProxy(raw: string): boolean | string[] {
  const value = raw.trim();
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^[0-9]+$/.test(value)) {
    throw new Error(
      'Invalid TRUST_PROXY: numeric hop counts are unsafe; name the proxy IP address or CIDR',
    );
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  return entries;
}

/**
 * `''` → null (API-only). Anything else must be a directory holding the
 * bundle's `index.html`, resolved to an absolute path with no trailing slash;
 * otherwise boot refuses, because an image or an operator that names a web
 * root without a client in it has misconfigured the process, not asked for the
 * API-only relay.
 */
function parseWebRoot(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  const root = resolve(value);
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(
      `WEB_ROOT=${value} has no index.html: it must name the web client's built bundle, ` +
        `or be unset for the API-only relay`,
    );
  }
  return root;
}

const EnvSchema = z.object({
  JELLYFIN_URL: z.string().min(1),
  PORT: intVar(0).max(65535).default(8484),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  ALLOWED_ORIGINS: z.string().default(''),
  // How long a device Jellyfin has signed out keeps its seat, at most (security review L5). One
  // `/Users/Me` per live session per interval.
  TOKEN_REVALIDATE_INTERVAL_MS: intVar(1000).default(300_000),
  TOKEN_VALIDATION_CACHE_TTL_MS: intVar(0).default(60_000),
  // The one relay-wide room setting (PROTOCOL.md § 8.2): the operator's,
  // set here and nowhere else — no client reads or writes it, and nothing is
  // persisted beside the environment. A change is edit, restart. The settings
  // a new room inherits are not the operator's: `DEFAULT_ROOM_SETTINGS` in the
  // protocol is the fallback for a host who did not choose, and the choice
  // itself is the host's.
  MAX_ROOM_PARTICIPANTS: intVar(1).max(MAX_ROOM_PARTICIPANTS_LIMIT).default(16),
  // How long a room with no participants is kept before it is removed, and
  // where live rooms are persisted so a restart does not end every party.
  EMPTY_ROOM_TTL_MS: intVar(0).default(900_000),
  // How many rooms the relay holds at once, live and idle, and how many of them one account may
  // hold (security review H1). The relay cap cannot exceed what the rooms document carries across
  // a restart (`MAX_PERSISTED_ROOMS`), so no room the relay accepted is lost to the file's limit.
  MAX_ROOMS: intVar(1).max(MAX_PERSISTED_ROOMS).default(200),
  MAX_ROOMS_PER_USER: intVar(1).default(5),
  ROOMS_PATH: z.string().min(1).default('./data/rooms.json'),
  // The relay's identity key (PROTOCOL.md § 2.1) lives beside the rooms; the
  // `/v1/ws` URLs discovery advertises, else one is derived per request.
  IDENTITY_PATH: z.string().min(1).default('./data/relay-identity.json'),
  BASE_PATH: z.string().default(''),
  ADVERTISED_URLS: z.string().default(''),
  // The web client's built bundle, served by this process at BASE_PATH so the
  // client and the relay share an origin (the browser runtime
  // derives the socket URL from the page). Unset: API-only — what the
  // published source builds, since the bundle is not in it. The
  // `screenfin-server` image sets it to the bundle it carries.
  WEB_ROOT: z.string().default(''),
  DISCOVERY_RATE_LIMIT_PER_IP: intVar(1).default(60),
  HELLO_TIMEOUT_MS: intVar(100).default(10_000),
  MAX_PENDING_SOCKETS: intVar(1).default(100),
  MAX_PENDING_SOCKETS_PER_IP: intVar(1).default(10),
  MAX_SESSIONS: intVar(1).default(10_000),
  MAX_SESSIONS_PER_USER: intVar(1).default(10),
  HELLO_RATE_LIMIT_PER_IP: intVar(1).default(30),
  // How much to trust X-Forwarded-For. See parseTrustProxy.
  TRUST_PROXY: z.string().default(''),
  // Optional overrides for every DEFAULT_SYNC_CONFIG field.
  PING_INTERVAL_MS: intVar(250).optional(),
  POSITION_REPORT_INTERVAL_MS: intVar(250).optional(),
  DRIFT_IGNORE_MS: z.coerce.number().min(0).optional(),
  DRIFT_HARD_MS: z.coerce.number().min(0).optional(),
  RATE_CORRECTION: z.coerce.number().min(0.001).max(0.5).optional(),
  ACK_TIMEOUT_MS: intVar(100).optional(),
  CLIENT_TIMEOUT_MS: intVar(1000).optional(),
  RECONNECT_GRACE_MS: intVar(0).optional(),
  BUFFERING_MAX_WAIT_MS: intVar(0).optional(),
  // The stalled-seat rule: how long a seat may report `buffering` without a break, while the room's
  // timeline
  // runs, before the relay removes it from the party with the reason. 0 turns the removal off.
  STALLED_SEAT_REMOVE_MS: intVar(0).default(60_000),
});

export interface AppConfig {
  /** Normalized operator-controlled base used only for `/Users/Me` validation. */
  jellyfinUrl: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  /** Empty array = allow all origins (a warning is logged at startup). */
  allowedOrigins: string[];
  tokenRevalidateIntervalMs: number;
  tokenValidationCacheTtlMs: number;
  /**
   * Largest number of participants a room accepts (`MAX_ROOM_PARTICIPANTS`);
   * the lobby roster carries it as `capacity`.
   */
  maxRoomParticipants: number;
  /**
   * How long a room whose last participant left is held before it is removed.
   * The window exists so a reload, a walk to the kitchen, or a relay restart
   * does not destroy a party that is about to be rejoined. 0 removes the room
   * as soon as it empties.
   */
  emptyRoomTtlMs: number;
  /** Rooms the relay holds at once, live and idle (`MAX_ROOMS`). */
  maxRooms: number;
  /** Rooms one Jellyfin account holds at once (`MAX_ROOMS_PER_USER`). */
  maxRoomsPerUser: number;
  /** Where live rooms are persisted so they survive a restart (PROTOCOL.md § 8). */
  roomsPath: string;
  /** Where the relay's P-256 identity key is persisted (PROTOCOL.md § 2.1). */
  identityPath: string;
  /** Path prefix every route is mounted under; `''` for the root. */
  basePath: string;
  /**
   * Absolute path of the web client's bundle to serve at `basePath`, or `null`
   * for the API-only relay. Checked at boot: a value naming a directory with
   * no `index.html` is a misconfiguration, refused like any other.
   */
  webRoot: string | null;
  /**
   * The `/v1/ws` URLs the discovery document advertises, in priority order.
   * Empty = derive one from each request's own scheme and host.
   */
  advertisedUrls: string[];
  /** Allowed `GET /v1/discovery` requests per client IP per minute. */
  discoveryRateLimitPerIp: number;
  helloTimeoutMs: number;
  /** Global cap on sockets that have not yet sent a valid `session.hello`. */
  maxPendingSockets: number;
  /** Per-address cap on the same, so one host cannot consume the global pool. */
  maxPendingSocketsPerIp: number;
  /** Cap on the total session registry size. */
  maxSessions: number;
  /** Cap on concurrent sessions per Jellyfin-verified user id. */
  maxSessionsPerUser: number;
  /** Allowed `session.hello` attempts per client IP per minute. */
  helloRateLimitPerIp: number;
  /** Fastify `trustProxy`: X-Forwarded-For is honored only when this is set. */
  trustProxy: boolean | string[];
  /**
   * How long a seat may stay stuck buffering before the relay removes it from its party
   * (`STALLED_SEAT_REMOVE_MS`, the stalled-seat rule, PROTOCOL.md § 13.4). 0 turns the removal off.
   * Not part of
   * `syncConfig`: no client acts on the number, only on the `room.removed` that follows it.
   */
  stalledSeatRemoveMs: number;
  syncConfig: SyncConfig;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  // Unset and empty-string variables both mean "use the default".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value.trim();
  }

  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  const syncConfig = SyncConfigSchema.parse({
    pingIntervalMs: e.PING_INTERVAL_MS ?? DEFAULT_SYNC_CONFIG.pingIntervalMs,
    positionReportIntervalMs:
      e.POSITION_REPORT_INTERVAL_MS ?? DEFAULT_SYNC_CONFIG.positionReportIntervalMs,
    driftIgnoreMs: e.DRIFT_IGNORE_MS ?? DEFAULT_SYNC_CONFIG.driftIgnoreMs,
    driftHardMs: e.DRIFT_HARD_MS ?? DEFAULT_SYNC_CONFIG.driftHardMs,
    rateCorrection: e.RATE_CORRECTION ?? DEFAULT_SYNC_CONFIG.rateCorrection,
    ackTimeoutMs: e.ACK_TIMEOUT_MS ?? DEFAULT_SYNC_CONFIG.ackTimeoutMs,
    clientTimeoutMs: e.CLIENT_TIMEOUT_MS ?? DEFAULT_SYNC_CONFIG.clientTimeoutMs,
    reconnectGraceMs: e.RECONNECT_GRACE_MS ?? DEFAULT_SYNC_CONFIG.reconnectGraceMs,
    // The relay's own default, not the protocol's: 0 is no cap, so "wait for them" waits for as
    // long as the buffering seat stays connected. A value above 0 caps each seat's hold.
    bufferingMaxWaitMs: e.BUFFERING_MAX_WAIT_MS ?? 0,
  } satisfies SyncConfig);

  return {
    jellyfinUrl: parseJellyfinUrl(e.JELLYFIN_URL),
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    tokenRevalidateIntervalMs: e.TOKEN_REVALIDATE_INTERVAL_MS,
    tokenValidationCacheTtlMs: e.TOKEN_VALIDATION_CACHE_TTL_MS,
    maxRoomParticipants: e.MAX_ROOM_PARTICIPANTS,
    emptyRoomTtlMs: e.EMPTY_ROOM_TTL_MS,
    maxRooms: e.MAX_ROOMS,
    maxRoomsPerUser: e.MAX_ROOMS_PER_USER,
    roomsPath: e.ROOMS_PATH,
    identityPath: e.IDENTITY_PATH,
    basePath: parseBasePath(e.BASE_PATH),
    advertisedUrls: parseAdvertisedUrls(e.ADVERTISED_URLS),
    webRoot: parseWebRoot(e.WEB_ROOT),
    discoveryRateLimitPerIp: e.DISCOVERY_RATE_LIMIT_PER_IP,
    helloTimeoutMs: e.HELLO_TIMEOUT_MS,
    maxPendingSockets: e.MAX_PENDING_SOCKETS,
    maxPendingSocketsPerIp: e.MAX_PENDING_SOCKETS_PER_IP,
    maxSessions: e.MAX_SESSIONS,
    maxSessionsPerUser: e.MAX_SESSIONS_PER_USER,
    helloRateLimitPerIp: e.HELLO_RATE_LIMIT_PER_IP,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    stalledSeatRemoveMs: e.STALLED_SEAT_REMOVE_MS,
    syncConfig,
  };
}
