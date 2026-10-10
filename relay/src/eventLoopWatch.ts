import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Name an event-loop stall in the log.
 *
 * Measured: a backup of the relay's VM held the event loop for 46 to 112 s at a time
 * mid-party. Nothing in the log said so — not the liveness sweep, which runs on the same loop, nor
 * the healthcheck, which simply went unanswered — and it took a host-level `sar` to find it. The
 * loop's own delay histogram, sampled every `SAMPLE_INTERVAL_MS`, says it in one line.
 */
export const STALL_WARN_MS = 1_000;
const SAMPLE_INTERVAL_MS = 10_000;

/** The worst delay in one window, in milliseconds, when it is worth a warning; null otherwise. */
export function stallToReport(maxDelayNs: number): number | null {
  const ms = Math.round(maxDelayNs / 1e6);
  return ms >= STALL_WARN_MS ? ms : null;
}

export interface EventLoopWatchLogger {
  warn: (obj: object, msg?: string) => void;
}

/** Start watching; the returned function stops it. Never keeps the process alive. */
export function watchEventLoop(logger: EventLoopWatchLogger): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 50 });
  histogram.enable();
  const timer = setInterval(() => {
    const ms = stallToReport(histogram.max);
    histogram.reset();
    if (ms !== null) {
      logger.warn(
        { maxDelayMs: ms },
        'the event loop stalled; sockets, pongs and the healthcheck waited on it',
      );
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
