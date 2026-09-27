import type { RoomPlayback } from './room';
import type { SyncConfig } from './syncConfig';

export type TimelineLike = Pick<RoomPlayback, 'state' | 'positionMs' | 'measuredAt' | 'rate'>;

/**
 * The authoritative playback position at a given server time.
 *
 * While `playing`, the timeline advances at `rate` from the last measurement;
 * in every other state it is frozen at `positionMs`.
 */
export function expectedPositionMs(playback: TimelineLike, atServerTimeMs: number): number {
  if (playback.state !== 'playing') return playback.positionMs;
  return Math.max(0, playback.positionMs + (atServerTimeMs - playback.measuredAt) * playback.rate);
}

export type DriftAction =
  | { kind: 'none' }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; toPositionMs: number };

export interface DriftPlan {
  expectedPositionMs: number;
  /** localPositionMs - expectedPositionMs. Positive = local player is ahead. */
  driftMs: number;
  action: DriftAction;
}

/**
 * Decide how a client should correct drift against the authoritative timeline.
 *
 * - |drift| <= driftIgnoreMs             → no correction (restore rate 1 if adjusted).
 * - driftIgnoreMs < |drift| < driftHardMs → while playing: temporary rate adjustment
 *   (ahead → slow down, behind → speed up); while frozen: hard seek.
 * - |drift| >= driftHardMs               → hard seek to the expected position.
 *
 * Corrections produced here are synchronization actions, NOT user commands:
 * clients MUST NOT re-broadcast them as playback commands.
 */
export function planDriftCorrection(args: {
  localPositionMs: number;
  playback: TimelineLike;
  serverNowMs: number;
  config: Pick<SyncConfig, 'driftIgnoreMs' | 'driftHardMs' | 'rateCorrection'>;
}): DriftPlan {
  const expected = expectedPositionMs(args.playback, args.serverNowMs);
  const driftMs = args.localPositionMs - expected;
  const abs = Math.abs(driftMs);
  const { driftIgnoreMs, driftHardMs, rateCorrection } = args.config;

  if (abs <= driftIgnoreMs) {
    return { expectedPositionMs: expected, driftMs, action: { kind: 'none' } };
  }
  if (abs >= driftHardMs || args.playback.state !== 'playing') {
    return { expectedPositionMs: expected, driftMs, action: { kind: 'seek', toPositionMs: expected } };
  }
  const rate =
    driftMs > 0
      ? args.playback.rate * (1 - rateCorrection)
      : args.playback.rate * (1 + rateCorrection);
  return { expectedPositionMs: expected, driftMs, action: { kind: 'rate', rate } };
}
