import { z } from 'zod';

/** Unique per-message identifier. Senders SHOULD use UUID v4. */
export const MessageIdSchema = z.string().min(8).max(64);

/** Server-generated room identifier; short, URL-safe, shareable. */
export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

/** Participant identifier. Equal to the relay session id of the connection. */
export const ParticipantIdSchema = z.string().min(4).max(64);

/** Jellyfin item id (opaque to the sync server). */
export const ItemIdSchema = z.string().min(1).max(128);

/**
 * Jellyfin user id returned by `/Users/Me`. Opaque to the relay. Control
 * characters are excluded because the value is echoed on the wire.
 */
export const UserIdSchema = z
  .string()
  .min(1)
  .max(128)
  // eslint-disable-next-line no-control-regex -- excluding control characters is the point
  .regex(/^[^\u0000-\u001F\u007F]+$/);

/**
 * Human-visible display name derived from `/Users/Me` and echoed by the relay,
 * so it is length-bounded and MUST NOT contain control, line-separator,
 * bidi-override, or zero-width formatting characters. The relay normalizes the
 * upstream name into this wire-safe form before constructing protocol messages.
 */
export const DisplayNameSchema = z
  .string()
  .min(1)
  .max(64)
  // eslint-disable-next-line no-control-regex -- excluding control characters is the point
  .regex(/^[^\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/);

/**
 * Room title, chosen by whoever creates the room. Like a display name this is
 * client-supplied and echoed to every other session (via `lobby.state`), so it
 * carries the same character restrictions — a room
 * name reaches strictly more people's screens than any one participant's name.
 */
export const RoomNameSchema = z
  .string()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- excluding control characters is the point
  .regex(/^[^\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/);

/**
 * A Jellyfin `OfficialRating` name (`G`, `TV-Y7`, `R`, `16+`) as advertised for
 * display in `lobby.state`. Jellyfin's own vocabulary, never Screenfin's, so it
 * is an open bounded string rather than an enum: `GET /Localization/ParentalRatings`
 * returns 56 names on a US-locale server and a different set elsewhere, and the
 * real library carries names that ladder does not list at all (measured: `16+` and `M` are both in
 * the library and both absent from it).
 * Client-supplied only in the sense that it is echoed to every session, so it
 * carries the same character restrictions as a room name.
 */
export const MaturityRatingSchema = z
  .string()
  .min(1)
  .max(64)
  // eslint-disable-next-line no-control-regex -- excluding control characters is the point
  .regex(/^[^\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/);

/** Unix epoch time in milliseconds. */
export const UnixMillisSchema = z.number().int().nonnegative();

/** Media position in milliseconds from the start of the item. */
export const PositionMsSchema = z.number().finite().min(0);

/** Playback rate multiplier (1 = normal speed). */
export const PlaybackRateSchema = z.number().min(0.25).max(4);

export type MessageId = z.infer<typeof MessageIdSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type ItemId = z.infer<typeof ItemIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type DisplayName = z.infer<typeof DisplayNameSchema>;
export type RoomName = z.infer<typeof RoomNameSchema>;
