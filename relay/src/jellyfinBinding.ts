import { JellyfinServerIdSchema } from '@screenfin/protocol';
import { readBoundedJson } from './jellyfinHttp';

/**
 * Which Jellyfin this relay is bound to, by the server's own `Id`.
 *
 * Read from `GET <JELLYFIN_URL>/System/Info/Public` — credential-free, so it is
 * neither of the two user-token requests in the relay's security boundary and adds nothing
 * a user could be impersonated with. The answer lives here in memory and in the
 * discovery document; there is deliberately **no persisted copy and no
 * `JELLYFIN_ID` override** (joint § 7a Amendment 1): a file the operator never
 * wrote would be trust-on-first-use of whatever answered the URL that day, and
 * an env pin only catches an honest mismatch the clients already detect. One
 * source of truth — the URL — and nothing hidden.
 *
 * Boot never waits on it (`config.ts`: Jellyfin being down must not crash-loop
 * the relay). Until it is known, discovery advertises `null` and every client
 * fails closed, which is the right answer for a relay that is not bound to
 * anything yet.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
/** A discovery flood must not become a `/System/Info/Public` flood. */
const DEFAULT_RETRY_COOLDOWN_MS = 10_000;
const MAX_INFO_BODY_BYTES = 64 * 1024;

export interface JellyfinBinding {
  /** The `Id` as last read, or `null` while unknown. */
  current(): string | null;
  /**
   * The value now, asking Jellyfin first when it is unknown and the last attempt
   * was longer than the cooldown ago. Concurrent callers share one request.
   */
  ensure(): Promise<string | null>;
  /** Ask Jellyfin now, cooldown or not. Never rejects. */
  refresh(): Promise<string | null>;
  /**
   * Called the moment the `Id` goes from unknown to known — whether the boot
   * read, the hourly re-read or a discovery request's `ensure()` is what
   * learned it. Not called again for the same `Id`; a later change is warned,
   * not announced, because nothing downstream should re-bind to it silently.
   */
  onBound(listener: (jellyfinServerId: string) => void): void;
  /** Start the background re-read; a chore, so it never holds the process up. */
  start(): void;
  stop(): void;
}

export interface JellyfinBindingDeps {
  /** Already validated and normalized by loadConfig. */
  jellyfinUrl: string;
  fetchImpl?: typeof fetch;
  clock: () => number;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  requestTimeoutMs?: number;
  refreshIntervalMs?: number;
  retryCooldownMs?: number;
}

export function createJellyfinBinding(deps: JellyfinBindingDeps): JellyfinBinding {
  const { jellyfinUrl, clock, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retryCooldownMs = deps.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;

  let id: string | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<string | null> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const boundListeners: Array<(jellyfinServerId: string) => void> = [];

  const read = async (): Promise<string | null> => {
    lastAttemptAt = clock();
    try {
      const response = await fetchImpl(`${jellyfinUrl}/System/Info/Public`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        throw new Error(`Jellyfin /System/Info/Public answered ${response.status}`);
      }
      const body = (await readBoundedJson(
        response,
        MAX_INFO_BODY_BYTES,
        '/System/Info/Public',
      )) as {
        Id?: unknown;
      };
      const parsed = JellyfinServerIdSchema.safeParse(body?.Id);
      if (!parsed.success) throw new Error('Jellyfin /System/Info/Public carried no usable Id');

      const firstBinding = id === null;
      if (firstBinding) {
        logger.info(
          { jellyfinServerId: parsed.data },
          `Bound to Jellyfin ${parsed.data} at ${jellyfinUrl}`,
        );
      } else if (id !== parsed.data) {
        // Not an error the relay can act on — the URL is the truth — but every
        // client pinned to the old Id is about to refuse this relay, and the
        // operator should hear it from here first.
        logger.warn(
          { previous: id, jellyfinServerId: parsed.data },
          `Jellyfin Id at ${jellyfinUrl} changed; clients pinned to the previous server will refuse this relay`,
        );
      }
      id = parsed.data;
      if (firstBinding) {
        for (const listener of boundListeners) listener(parsed.data);
      }
      return id;
    } catch (err) {
      logger.warn(
        { err },
        id === null
          ? `could not read the Jellyfin Id from ${jellyfinUrl}; discovery advertises null until it can`
          : `could not re-read the Jellyfin Id from ${jellyfinUrl}; keeping the last known value`,
      );
      return id;
    }
  };

  const refresh = (): Promise<string | null> => {
    if (inFlight === null) {
      inFlight = read().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  return {
    current: () => id,
    ensure(): Promise<string | null> {
      if (id !== null) return Promise.resolve(id);
      if (inFlight !== null) return inFlight;
      if (lastAttemptAt !== null && clock() - lastAttemptAt < retryCooldownMs) {
        return Promise.resolve(null);
      }
      return refresh();
    },
    refresh,
    onBound(listener): void {
      boundListeners.push(listener);
    },
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void refresh();
      }, deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
      timer.unref();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
