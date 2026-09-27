import { z } from 'zod';

/**
 * Client-relevant synchronization tuning. The server sends its effective
 * configuration in `session.welcome`; clients MUST use the received values
 * rather than hardcoding their own.
 */
export const SyncConfigSchema = z.object({
  /** Interval between `sync.ping` messages (clock sync + liveness). */
  pingIntervalMs: z.number().int().min(250),
  /** Interval between `client.position` reports while media is loaded. */
  positionReportIntervalMs: z.number().int().min(250),
  /** Drift (|local - expected|) at or below this is ignored. */
  driftIgnoreMs: z.number().min(0),
  /** Drift at or above this is corrected with a hard seek. */
  driftHardMs: z.number().min(0),
  /**
   * Fractional playback-rate adjustment used to correct drift between
   * `driftIgnoreMs` and `driftHardMs` (e.g. 0.05 → play at 0.95x/1.05x).
   */
  rateCorrection: z.number().min(0.001).max(0.5),
  /** How long a client waits for an ack before re-sending a command (same id). */
  ackTimeoutMs: z.number().int().min(100),
  /** Server drops a connection with no inbound traffic for this long. */
  clientTimeoutMs: z.number().int().min(1000),
  /** Window during which a disconnected session can resume with full state. */
  reconnectGraceMs: z.number().int().min(0),
  /** Max time a `pause-all` room stays in `waiting` for one buffering participant. */
  bufferingMaxWaitMs: z.number().int().min(0),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  pingIntervalMs: 5_000,
  positionReportIntervalMs: 2_000,
  driftIgnoreMs: 150,
  driftHardMs: 1_500,
  rateCorrection: 0.05,
  ackTimeoutMs: 3_000,
  clientTimeoutMs: 30_000,
  reconnectGraceMs: 60_000,
  bufferingMaxWaitMs: 30_000,
};
