import { z } from 'zod';
import {
  DisplayNameSchema,
  ItemIdSchema,
  MaturityRatingSchema,
  ParticipantIdSchema,
  PlaybackRateSchema,
  PositionMsSchema,
  RoomIdSchema,
  RoomNameSchema,
  UnixMillisSchema,
  UserIdSchema,
} from './common';

/**
 * Hard ceiling on a room's participants — the bound on `RoomState.participants`,
 * and the most a relay operator may set `MAX_ROOM_PARTICIPANTS` to.
 */
export const MAX_ROOM_PARTICIPANTS_LIMIT = 100;

/**
 * Room-level playback state.
 * - `idle`: no media item selected.
 * - `playing`: the shared timeline is advancing.
 * - `paused`: the shared timeline is frozen by a user command.
 * - `waiting`: the shared timeline is frozen by the buffering policy
 *   (one or more participants are buffering); resumes automatically.
 */
export const PlaybackStateSchema = z.enum(['idle', 'playing', 'paused', 'waiting']);

/** A participant's local player state as last reported by that client. */
export const PlayerStateSchema = z.enum([
  'idle',
  'loading',
  'ready',
  'playing',
  'paused',
  'buffering',
]);

export const ParticipantRoleSchema = z.enum(['host', 'guest']);

export const ConnectionStateSchema = z.enum(['connected', 'reconnecting']);

/**
 * Who may issue playback commands (play/pause/seek/setItem).
 *
 * **Not the queue**. Editing the queue is not a playback control:
 * `queue.set` is the host's whatever this says, on the same footing as
 * `room.setSettings`. That rule lives in PROTOCOL.md § 8 ("Host") and is
 * enforced by the relay's `setQueue`, not here.
 */
export const ControlModeSchema = z.enum(['host-only', 'everyone']);

/**
 * What the room does when a participant reports buffering during playback.
 * - `pause-all`: room enters `waiting` until the buffering participants recover
 *   (or `bufferingMaxWaitMs` elapses).
 * - `ignore`: the room keeps playing; the buffering participant catches up on
 *   its own via drift correction.
 */
export const BufferingPolicySchema = z.enum(['pause-all', 'ignore']);

export const QueueItemSchema = z.object({
  itemId: ItemIdSchema,
});

export const RoomSettingsSchema = z.object({
  controlMode: ControlModeSchema,
  bufferingPolicy: BufferingPolicySchema,
});

/**
 * What a room is given for any setting its `room.create` omits (§ 8.2).
 *
 * A host who did not choose keeps control and waits while another participant
 * buffers. Clients show these choices on the new-party screen and may send
 * personal preferences instead. There is no operator override. Swift
 * `RoomSettings.defaults` and Kotlin
 * `RoomSettings.DEFAULTS` mirror this value.
 */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  controlMode: 'host-only',
  bufferingPolicy: 'pause-all',
};

/**
 * The authoritative shared timeline.
 *
 * When `state` is `playing`, the authoritative position at server time `t` is:
 *   positionMs + (t - measuredAt) * rate
 * For every other state the authoritative position is exactly `positionMs`.
 */
export const RoomPlaybackSchema = z.object({
  itemId: ItemIdSchema.nullable(),
  queue: z.array(QueueItemSchema).max(500),
  queueIndex: z.number().int().min(0).nullable(),
  /**
   * **What constrains the room** (§ 8): the lowest Jellyfin maturity ceiling
   * among the seated participants who have one, named by the server's
   * `/Localization/ParentalRatings` ladder (`7` → `TV-Y7`; the bare number when
   * no entry matches) — or, when no seat has a ceiling, the highest
   * `OfficialRating` among the room's media, the current item **and** the whole
   * queue, or `null` when the room holds nothing rated, including a room with
   * no media at all. **For display, and never the gate** (§ 8, § 8.1).
   *
   * It moves with the roster as well as the queue: a relay re-derives it on
   * join, leave, grace expiry and host transfer as on `setItem` and `queue.set`,
   * and a client draws whatever the latest `room.state` says. It sits beside
   * `queue` because it summarizes it — the ceiling over the room rather than the
   * rating of what is on screen, which is also why it does not flicker as the
   * queue advances. The ceiling itself is never on the wire, only its name.
   *
   * The gate is Jellyfin's answer, not arithmetic on this string. A relay asks
   * `GET /Items?userId=…&Ids=…` which items a given account may see, keeps a
   * listed room out of that account's roster when any is withheld, and refuses
   * that account's join; this field is what lets a room screen say "PG-13" to
   * somebody already in it. A client that re-derives visibility from it will be
   * wrong, because the comparison it would have to make is not expressible:
   * Measured, `16+` and `M` are in a real library, are
   * absent from `/Localization/ParentalRatings` entirely, and are blocked by
   * Jellyfin for an account whose ceiling permits `TV-Y7`.
   *
   * Ordering, when a relay computes the maximum: by the ladder's `RatingScore`
   * (`score`, then `subScore` — `R` is `(17,0)` and `TV-MA` is `(17,1)`), with
   * any name the ladder does not score sorting ABOVE every name it does. That
   * direction is deliberate: an unscored name has been observed blocked at a
   * ceiling that permits `TV-Y7`, so calling it low is the unsafe way to be
   * wrong about a label.
   */
  maturityRating: MaturityRatingSchema.nullable(),
  /**
   * Whether any of the room's media carries no effective `OfficialRating`.
   *
   * **A second axis, not a low rating**, and it cannot be folded into
   * `maturityRating`: Jellyfin's `BlockUnratedItems` is per user, so the same
   * room is watchable by one account and not another with an identical ceiling.
   * Also display-only.
   *
   * Measured, by setting `BlockUnratedItems: ["Movie"]` on a test
   * account and restoring it: Jellyfin withheld the items rated `NR`,
   * `Not Rated` and `Unrated` alongside the ones carrying no rating at all, and
   * kept `16+`, `M`, `G` and `TV-MA` visible. Those names are therefore this
   * axis rather than low rungs of the other one, and a relay computing the pair
   * excludes them from `maturityRating`.
   */
  containsUnrated: z.boolean(),
  state: PlaybackStateSchema,
  positionMs: PositionMsSchema,
  /** Server clock (unix ms) at which `positionMs` was measured. */
  measuredAt: UnixMillisSchema,
  rate: PlaybackRateSchema,
});

export const ParticipantSchema = z.object({
  participantId: ParticipantIdSchema,
  userId: UserIdSchema,
  userName: DisplayNameSchema,
  role: ParticipantRoleSchema,
  connection: ConnectionStateSchema,
  playerState: PlayerStateSchema,
  lastPositionMs: PositionMsSchema.nullable(),
  lastReportAt: UnixMillisSchema.nullable(),
  joinedAt: UnixMillisSchema,
});

export const RoomStateSchema = z.object({
  roomId: RoomIdSchema,
  name: RoomNameSchema.nullable(),
  createdAt: UnixMillisSchema,
  /**
   * Server clock at the room's first transition into `playing`, `null` while
   * the room is a lobby.
   *
   * **This is what separates a lobby from a paused room, and nothing else can.**
   * A freshly created room carrying an item sits at `paused` / `positionMs: 0`,
   * which is indistinguishable from a room a host seeked back to the start and
   * paused. Clients draw the lobby while this is `null`, so inferring it from
   * the position instead would throw a whole party back to the lobby mid-film.
   *
   * **A one-way latch for the life of a party, not for the life of a room**, and
   * the distinction is load-bearing. It survives pause, seek-to-zero, resume and
   * the persistence round-trip — none of those mean the party stopped. It is
   * cleared by the two things that genuinely return a room to its lobby:
   *
   * - the room losing its last participant (§ 8: it stays listed and joinable
   *   through the idle window, and whoever walks back in is starting rather
   *   than arriving late); and
   * - `playback.setItem`, because a different film has not begun.
   *
   * It survived the idle window until clients had shipped a lobby, at which
   * point that read as "this party began" forever. Clients use it for two
   * decisions — what Start means (play for everybody, or walk me into a film
   * already running) and whether a room appearing should open the player, the
   * latter being a `false -> true` transition a permanently-`true` field can
   * never make again — so a rejoined room could not be started together by
   * anybody.
   *
   * The playback position is deliberately *not* reset alongside it: coming back
   * into an emptied room resumes where the room was.
   */
  startedAt: UnixMillisSchema.nullable(),
  /**
   * Monotonically increasing revision, incremented on every room mutation.
   * Clients MUST apply a received room state only if its revision is greater
   * than the last applied revision, and drop it otherwise.
   */
  revision: z.number().int().min(0),
  hostParticipantId: ParticipantIdSchema,
  settings: RoomSettingsSchema,
  playback: RoomPlaybackSchema,
  participants: z.array(ParticipantSchema).max(MAX_ROOM_PARTICIPANTS_LIMIT),
});

export type PlaybackState = z.infer<typeof PlaybackStateSchema>;
export type PlayerState = z.infer<typeof PlayerStateSchema>;
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type ControlMode = z.infer<typeof ControlModeSchema>;
export type BufferingPolicy = z.infer<typeof BufferingPolicySchema>;
export type QueueItem = z.infer<typeof QueueItemSchema>;
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export type RoomPlayback = z.infer<typeof RoomPlaybackSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
