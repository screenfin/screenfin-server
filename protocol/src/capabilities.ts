import { z } from 'zod';

/**
 * Optional server features implemented by the current relay. These stable
 * names describe independently usable behavior, not a mirror of the message
 * catalog. The relay sends this exact list in every `session.welcome`.
 */
export const SERVER_CAPABILITIES = [
  'session.resume',
  'lobby.open-parties',
  'room.display-name',
  'room.settings',
  'room.host-transfer',
  'playback.queue',
  'playback.buffering-coordination',
  /**
   * `RoomState.startedAt` is populated (§ 8). Without this, a client cannot read
   * a missing `startedAt` as "this party has not begun" — Swift and Kotlin
   * decode an absent key and an explicit `null` to the same `nil`, so the
   * capability is the only thing that separates a relay reporting a lobby from
   * a relay that has never heard of one.
   */
  'room.started-at',
  /**
   * `lobby.state` is filtered for the receiving session, and `RoomState`'s
   * `playback` carries `maturityRating` and `containsUnrated` (§ 3.1, § 8,
   * § 8.1).
   *
   * The name still fits after the display pair moved off `LobbyGroup`: what it
   * describes is the **filtering**, which is unchanged, and the summary is a
   * fact about the same rule seen from inside the room rather than a second
   * feature.
   *
   * Without it a client cannot tell a roster that omits a party because this
   * account may not see its media from a roster that simply has no such party —
   * the frame looks identical either way — and so cannot say "some parties are
   * hidden by your Jellyfin's parental controls" rather than "no parties". It
   * also states that `room.join` may answer `FORBIDDEN` for that reason, which
   * a client otherwise has to discover by being refused.
   */
  'lobby.maturity-filtered',
  /**
   * The relay has a persistent P-256 identity: it answers
   * `GET /v1/discovery?nonce=…` with a signed document (§ 2.1) and names itself
   * in `session.welcome.payload.relay` (§ 7). A client that verified discovery
   * before connecting can confirm the socket it holds belongs to the key it
   * verified; a relay without it answers no discovery document, so no client
   * connects to it at all — Paired is the only state (§ 7 rule 9).
   */
  'relay.identity',
  /**
   * The relay removes a seat that has reported `buffering` without a break for
   * `STALLED_SEAT_REMOVE_MS` while the room's timeline runs, sends that seat
   * `room.removed` with the reason, and gives everybody else the same reason on
   * the departure's cause (§ 13.4). The operator may set the delay to 0,
   * which turns the removal off; the capability says the relay speaks the
   * message, not that a removal will happen. A client without it has no reason
   * to show and no `room.removed` to expect.
   */
  'room.removed',
] as const;

/**
 * Capability names are deliberately open strings: future names must survive
 * decoding by older clients. Bounds prevent an untrusted welcome from growing
 * client state without limit.
 */
export const ServerCapabilitySchema = z.string().min(1).max(128);
export const ServerCapabilitiesSchema = z.array(ServerCapabilitySchema).max(128).readonly();

export type KnownServerCapability = (typeof SERVER_CAPABILITIES)[number];
export type ServerCapability = z.infer<typeof ServerCapabilitySchema>;
