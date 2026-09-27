/**
 * NTP-style clock-offset estimation from `sync.ping` / `sync.pong` exchanges.
 *
 * For a sample with client send time t0, server time t1, and client receive
 * time t3 (all unix ms):
 *   rtt    = t3 - t0
 *   offset = t1 - (t0 + rtt / 2)      // serverTime ≈ clientTime + offset
 */
export interface ClockSample {
  clientSendTime: number;
  serverTime: number;
  clientReceiveTime: number;
}

export interface ClockEstimate {
  /** serverTime ≈ clientTime + offsetMs */
  offsetMs: number;
  /** Round-trip time of the best sample(s) used. */
  rttMs: number;
  sampleCount: number;
}

export function sampleOffset(sample: ClockSample): { offsetMs: number; rttMs: number } {
  const rttMs = sample.clientReceiveTime - sample.clientSendTime;
  const offsetMs = sample.serverTime - (sample.clientSendTime + rttMs / 2);
  return { offsetMs, rttMs };
}

/**
 * Robust estimate over recent samples: keep the lowest-RTT half (max 5) and
 * take the median offset, so transient latency spikes don't skew the clock.
 */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate | null {
  const measured = samples
    .map(sampleOffset)
    .filter((s) => Number.isFinite(s.rttMs) && s.rttMs >= 0)
    .sort((a, b) => a.rttMs - b.rttMs);
  if (measured.length === 0) return null;

  const keep = measured.slice(0, Math.min(5, Math.max(1, Math.ceil(measured.length / 2))));
  const offsets = keep.map((s) => s.offsetMs).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const offsetMs =
    offsets.length % 2 === 1 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;

  return { offsetMs, rttMs: keep[0]!.rttMs, sampleCount: measured.length };
}
