/**
 * Fixed-window counter per key: the shape both pre-authentication limits share
 * — `session.hello` attempts (`./connection.ts`) and `GET /v1/discovery`
 * (`./server.ts`). Both key on the effective client address under the configured
 * proxy-trust policy, and both are decorative if that policy is wrong, which is
 * why they share one implementation rather than two that could drift.
 */
export interface FixedWindowLimiter {
  /**
   * Count one attempt for `key`; false when the key is over its window's limit —
   * or when the key is new and the table is already full of live windows, so the
   * bound on memory is a bound rather than a hint.
   */
  take(key: string): boolean;
  /**
   * Give back one attempt `take` counted in the current window: the attempt turned out to be one
   * the limit is not about (a hello that authenticated, `./connection.ts`).
   */
  refund(key: string): void;
  /** Keys currently tracked; never exceeds `maxTracked`. */
  size(): number;
}

export function createFixedWindowLimiter(opts: {
  clock: () => number;
  windowMs: number;
  limit: number;
  /** Distinct keys remembered before expired windows are swept. */
  maxTracked: number;
}): FixedWindowLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    take(key: string): boolean {
      const now = opts.clock();
      if (windows.size >= opts.maxTracked) {
        for (const [tracked, win] of windows) {
          if (now - win.windowStart >= opts.windowMs) windows.delete(tracked);
        }
      }
      const win = windows.get(key);
      if (win === undefined || now - win.windowStart >= opts.windowMs) {
        // A new key needs a slot. When the sweep freed none — every tracked
        // window is still live — refuse rather than grow: a flood of distinct
        // addresses then costs the relay nothing beyond this table, and the
        // keys already counting keep counting. Evicting would instead let that
        // flood reset a legitimate address's count.
        if (win === undefined && windows.size >= opts.maxTracked) return false;
        windows.set(key, { windowStart: now, count: 1 });
        return true;
      }
      win.count += 1;
      return win.count <= opts.limit;
    },
    refund(key: string): void {
      const win = windows.get(key);
      if (win === undefined || opts.clock() - win.windowStart >= opts.windowMs) return;
      win.count = Math.max(0, win.count - 1);
    },
    size: () => windows.size,
  };
}

/**
 * A continuously refilling token bucket per key, for the post-authentication bounds that belong to
 * an **account** rather than to one socket (`./rooms/manager.ts`): a household's ten sessions share
 * one budget, so a second device is no way around it. `take` may charge more than one token, for a
 * budget counted in items rather than in presses.
 */
export interface KeyedTokenBuckets {
  /**
   * Charge `cost` tokens to `key`; false, charging nothing, when the bucket holds fewer — or when
   * the key is new and the table is full of buckets still refilling.
   */
  take(key: string, cost?: number): boolean;
  /** Keys currently tracked; never exceeds `maxTracked`. */
  size(): number;
}

export function createKeyedTokenBuckets(opts: {
  clock: () => number;
  ratePerSecond: number;
  burst: number;
  /** Distinct keys remembered; buckets that have refilled completely are forgotten first. */
  maxTracked: number;
}): KeyedTokenBuckets {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refill = (bucket: { tokens: number; at: number }, now: number): void => {
    const elapsedMs = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(opts.burst, bucket.tokens + (elapsedMs / 1000) * opts.ratePerSecond);
    bucket.at = now;
  };
  return {
    take(key: string, cost = 1): boolean {
      const now = opts.clock();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        if (buckets.size >= opts.maxTracked) {
          // A full bucket is indistinguishable from a fresh one, so forgetting it loses nothing.
          for (const [tracked, other] of buckets) {
            refill(other, now);
            if (other.tokens >= opts.burst) buckets.delete(tracked);
          }
          // Like the fixed window above: refuse rather than evict a key that is still counting.
          if (buckets.size >= opts.maxTracked) return false;
        }
        bucket = { tokens: opts.burst, at: now };
        buckets.set(key, bucket);
      } else {
        refill(bucket, now);
      }
      if (bucket.tokens < cost) return false;
      bucket.tokens -= cost;
      return true;
    },
    size: () => buckets.size,
  };
}
