import type WebSocket from 'ws';

/**
 * How far behind one reader may fall before the relay stops writing to it (security review H2).
 *
 * `ws` queues whatever the kernel will not take, in this process's memory, for as long as the
 * socket stays open. The liveness sweep (`./connection.ts`) closes a client that stops *sending*,
 * and a client that stops *reading* while pinging once a second passes it forever — measured: one
 * such session reached 66.6 MB queued in 19 s, beside a room-creation flood, and
 * was never closed. Every send path (`./server.ts` broadcasts and lobby pushes, `./router.ts`
 * replies, `./connection.ts` handshake frames) now goes through `sendFrame`, so there is one bound
 * and no path around it.
 */
export interface OutboundLimits {
  /** Past this, frames a later frame supersedes are skipped rather than queued. */
  softBytes: number;
  /** A frame that would take the queue past this closes the socket instead. */
  hardBytes: number;
}

/**
 * A megabyte is dozens of full room snapshots — far more than a live reader on a slow link ever
 * has in flight — and four is the most one stalled reader can cost the relay.
 */
export const DEFAULT_OUTBOUND_LIMITS: OutboundLimits = {
  softBytes: 1024 * 1024,
  hardBytes: 4 * 1024 * 1024,
};

/**
 * Frames that are whole snapshots of something a later frame restates in full, and so can be
 * skipped for a reader that is behind without it ever acting on something false: `lobby.state`
 * is the whole roster, and `room.state` is the whole room at a revision — a client that notices
 * the gap asks for the room again (`room.stateRequest`, PROTOCOL.md § 6.3). Answers (`ack`,
 * `error`, `sync.pong`), `session.welcome` and `room.closed` are never skipped.
 */
export function isDroppableFrame(type: string): boolean {
  return type === 'lobby.state' || type === 'room.state';
}

export type SendOutcome = 'sent' | 'dropped' | 'terminated' | 'closed';

export function sendFrame(
  socket: WebSocket,
  frame: string,
  opts: { droppable: boolean; limits?: OutboundLimits },
): SendOutcome {
  if (socket.readyState !== socket.OPEN) return 'closed';
  const limits = opts.limits ?? DEFAULT_OUTBOUND_LIMITS;
  // A stand-in socket may not model the queue; treat it as keeping up.
  const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
  if (buffered + Buffer.byteLength(frame) > limits.hardBytes) {
    // What the silent-connection sweep does: the session goes into its ordinary reconnect grace,
    // and a client that was merely slow comes back and resumes.
    socket.terminate();
    return 'terminated';
  }
  if (opts.droppable && buffered > limits.softBytes) return 'dropped';
  socket.send(frame);
  return 'sent';
}
