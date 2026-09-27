import { createHash } from 'node:crypto';
import { DisplayNameSchema, UserIdSchema } from '@screenfin/protocol';
import { jellyfinAuthHeader, readBoundedJson } from './jellyfinHttp';

export interface JellyfinUser {
  userId: string;
  userName: string;
  /**
   * `Policy.MaxParentalRating` from the same `/Users/Me` body, or null for an
   * account with no ceiling — the maturity rule, where a party's
   * displayed level became the lowest ceiling seated in it, named by the
   * server's ladder (`visibility.ts`, `summarize`).
   *
   * It is one more field read off a body the relay already fetches, never a
   * second request, and it is held exactly as the token is: in the live
   * in-memory session only, never persisted, never logged, never on the wire —
   * the room carries the ladder's *name* for it, not the number. Measured
   * on a real Jellyfin 12.0.0: `test3` answers `7` as a JSON
   * integer, `test2` answers `null`; `MaxParentalSubRating` rides beside it and
   * is deliberately not read, because the room names a single value.
   */
  maturityCeiling: number | null;
}

export interface ValidateTokenOptions {
  forceRefresh?: boolean;
}

export interface JellyfinAuthenticator {
  /**
   * Validate against the authenticator's immutable, operator-configured server.
   * Resolves null only when Jellyfin rejects the credential (401/403).
   */
  validateToken(token: string, options?: ValidateTokenOptions): Promise<JellyfinUser | null>;
}

interface CacheEntry {
  value: JellyfinUser | null;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_VALIDATION_BODY_BYTES = 1_048_576;
const MAX_DISPLAY_NAME_UTF16_UNITS = 64;
// Keep this in lockstep with DisplayNameSchema. These scalars can make log/UI
// text ambiguous or invisible when the relay echoes an upstream Jellyfin name.
const FORBIDDEN_WIRE_SCALARS =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function normalizedDisplayNameCandidate(value: string): string {
  const stripped = value.replace(FORBIDDEN_WIRE_SCALARS, '').trim();
  let normalized = '';
  for (const { segment } of graphemeSegmenter.segment(stripped)) {
    if (normalized.length + segment.length > MAX_DISPLAY_NAME_UTF16_UNITS) break;
    normalized += segment;
  }
  return normalized;
}

function normalizeDisplayName(name: string, userId: string): string {
  const normalizedName = normalizedDisplayNameCandidate(name);
  if (normalizedName !== '') return normalizedName;

  const normalizedUserId = normalizedDisplayNameCandidate(userId);
  if (normalizedUserId !== '') return normalizedUserId;

  // UserIdSchema permits bidi/zero-width scalars that DisplayNameSchema does
  // not. If such scalars are the entire id, retain a stable safe identity hint.
  return `User-${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

/**
 * The account's maturity ceiling as `/Users/Me` states it, or null.
 *
 * Only an integer counts — that is what Jellyfin's `int?` emits — and a
 * `Policy` that is missing, malformed or carries anything else reads as "no
 * ceiling", never as a bad body: identity is `Id` and `Name`, and a policy the
 * relay cannot read must not refuse a token Jellyfin accepted. Failing towards
 * "no ceiling" is the display-safe direction, because the gate is Jellyfin's
 * `/Items` answer and reads none of this.
 */
function maturityCeilingOf(policy: unknown): number | null {
  if (typeof policy !== 'object' || policy === null) return null;
  const ceiling = (policy as { MaxParentalRating?: unknown }).MaxParentalRating;
  return typeof ceiling === 'number' && Number.isInteger(ceiling) ? ceiling : null;
}

export function createJellyfinAuthenticator(opts: {
  /** Already validated and normalized by loadConfig. */
  jellyfinUrl: string;
  cacheTtlMs: number;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  requestTimeoutMs?: number;
}): JellyfinAuthenticator {
  const jellyfinUrl = opts.jellyfinUrl;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? ((): number => Date.now());
  const cache = new Map<string, CacheEntry>();

  return {
    async validateToken(
      token: string,
      validationOptions: ValidateTokenOptions = {},
    ): Promise<JellyfinUser | null> {
      // Raw credentials never become cache keys and are not retained here.
      const key = createHash('sha256').update(token).digest('hex');
      const now = clock();
      const hit = cache.get(key);
      if (validationOptions.forceRefresh !== true && hit !== undefined && hit.expiresAt > now) {
        return hit.value;
      }
      if (hit !== undefined && hit.expiresAt <= now) cache.delete(key);

      const response = await fetchImpl(`${jellyfinUrl}/Users/Me`, {
        headers: { Authorization: jellyfinAuthHeader(token) },
        redirect: 'error',
        signal: AbortSignal.timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });

      let value: JellyfinUser | null;
      if (response.status === 200) {
        const body = (await readBoundedJson(response, MAX_VALIDATION_BODY_BYTES, '/Users/Me')) as {
          Id?: unknown;
          Name?: unknown;
          Policy?: unknown;
        };
        const id = UserIdSchema.safeParse(body?.Id);
        if (!id.success || typeof body?.Name !== 'string') {
          throw new Error('Jellyfin /Users/Me returned an unexpected body');
        }
        const name = DisplayNameSchema.parse(normalizeDisplayName(body.Name, id.data));
        value = {
          userId: id.data,
          userName: name,
          maturityCeiling: maturityCeilingOf(body.Policy),
        };
      } else if (response.status === 401 || response.status === 403) {
        value = null;
      } else {
        throw new Error(`Jellyfin token validation failed with status ${response.status}`);
      }

      if (cache.size >= MAX_CACHE_ENTRIES) {
        for (const [candidate, entry] of cache) {
          if (cache.size < MAX_CACHE_ENTRIES) break;
          if (entry.expiresAt <= now) cache.delete(candidate);
        }
        while (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      cache.set(key, { value, expiresAt: now + opts.cacheTtlMs });
      return value;
    },
  };
}
