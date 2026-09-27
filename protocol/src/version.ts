import { z } from 'zod';

/**
 * Permanent value stamped by every Screenfin message creator. Wire evolution
 * is additive and negotiated through `session.welcome.payload.capabilities`;
 * this field is no longer a compatibility gate and will not be bumped.
 * See PROTOCOL.md § 3.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Receive-side envelope validation. A recognized message whose shape is
 * compatible remains processable even when a future sender stamps a different
 * positive integer. Missing, non-integer, or non-positive values are invalid.
 */
export const EnvelopeVersionSchema = z.number().int().positive();

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type EnvelopeVersion = z.infer<typeof EnvelopeVersionSchema>;
