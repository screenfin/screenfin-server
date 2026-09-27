/**
 * **A dead session holds nothing.**
 *
 * The relay deliberately keeps a body around after its socket goes: a session survives
 * `reconnectGraceMs` (60 s) so a blip does not end somebody's evening, and its participant record
 * stays in the room as `reconnecting` so the seat is still theirs when they come back. That is
 * right, and neither of the rules below weakens it.
 *
 * What it must not do is let that body block **its own owner**. Two limits are enforced against a
 * proven Jellyfin identity rather than against a socket — the per-user session cap
 * (`connection.ts`) and one-device-per-room (`rooms/manager.ts`) — and both were counting a held
 * seat as an occupant. The failure is the same shape in both, and it is the worst shape a limit
 * can have: the user is refused, the refusal names a device that is *offline*, and there is no
 * action they can take to satisfy it. A television that lost wi-fi locked its owner out of their
 * own party, and a household's relaunch churn locked a user out of the relay entirely, both for
 * exactly the window that exists to help them.
 *
 * So the judgement, made once and used in both places: **a limit that exists to keep the peace
 * between live connections is only ever measured against live connections.** A holder whose socket
 * is gone yields to its own account without argument; the moment there is a socket on the other
 * end, the limit is real and the refusal is honest, because the other device is there to be
 * looked at.
 *
 * The two predicates are the same fact seen from either side of `connection.ts`'s close handler,
 * which nulls the socket and calls `RoomManager.handleDisconnect` in the same breath.
 */

/** A relay session still attached to a socket. */
export function sessionIsLive(session: { socket: unknown | null }): boolean {
  return session.socket !== null;
}

/** A room participant whose socket has not gone (the room's view of the same fact). */
export function participantIsLive(participant: {
  connection: 'connected' | 'reconnecting';
}): boolean {
  return participant.connection === 'connected';
}
