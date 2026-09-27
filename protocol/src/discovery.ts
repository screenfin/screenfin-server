import { z } from 'zod';
import { ServerCapabilitiesSchema } from './capabilities';

/**
 * Relay identity and signed discovery (PROTOCOL.md § 2.1).
 *
 * A relay proves *which key* answered before any client credential is sent:
 * `GET /v1/discovery?nonce=…` returns a document signed with the relay's
 * persistent P-256 key, and the client verifies the signature, the Jellyfin
 * `Id` it is bound to, the URL it is about to connect to, and one trust state
 * before `session.hello`. This module is the language-neutral half of that —
 * the schemas, the canonical byte form the signature covers, the acceptance
 * rules and the short-code arithmetic. It deliberately holds **no crypto**: the
 * web client bundles this package, so hashing and ECDSA stay with each
 * platform (Node `crypto`, WebCrypto, CryptoKit, `java.security`), and
 * `test/vectors/` proves they all agree.
 */

/** `GET <relay>/v1/discovery?nonce=<nonce>` — credential-free, `Cache-Control: no-store`. */
export const DISCOVERY_PATH = '/v1/discovery';
export const DISCOVERY_SCHEMA_VERSION = 1;
/** ECDSA over P-256 with SHA-256. The only algorithm defined so far (joint A3). */
export const DISCOVERY_ALG = 'ES256';
/**
 * Domain-separation tag: the first framed field of every canonical form, so a
 * relay key that later signs something else (a relay binding, a grant)
 * can never produce bytes that also verify as a discovery document.
 */
export const DISCOVERY_CONTEXT = 'screenfin/relay-discovery';
/** A relay MUST NOT issue a document that lives longer than this. */
export const DISCOVERY_MAX_LIFETIME_S = 60;
/**
 * How far a client's clock may disagree with the relay's before freshness
 * fails. Televisions are the worst case — a set-top box on an isolated LAN or
 * fresh from a cold boot can be minutes off — and the nonce, not the clock, is
 * what makes a replay impossible, so this is generous on purpose.
 */
export const DISCOVERY_CLOCK_SKEW_S = 300;
/** A client MUST stop reading a discovery response past this many bytes. */
export const DISCOVERY_MAX_RESPONSE_BYTES = 16 * 1024;
/** Per advertised URL; with `MAX_DISCOVERY_URLS` this keeps the document well inside the read bound. */
export const MAX_DISCOVERY_URL_LENGTH = 512;
/**
 * What the serialised `urls` array may occupy: half the response bound, so the
 * signed document — key, signature, capabilities, the rest — always fits.
 */
export const MAX_DISCOVERY_URLS_JSON_BYTES = 8 * 1024;
/**
 * `GET <jellyfin-base>/Branding/Configuration` — anonymous on every Jellyfin;
 * its `CustomCss` is where an administrator pastes the branding mark (§ 2.3).
 */
export const BRANDING_CONFIGURATION_PATH = '/Branding/Configuration';
/**
 * A client MUST stop reading a branding response past this many bytes. Far
 * larger than the other bounds on purpose: the mark is appended to whatever
 * theme the administrator already pasted, and a theme pasted inline runs to
 * hundreds of KiB, so a 16 KiB stop would lose the mark exactly where the
 * instructions put it.
 */
export const BRANDING_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * The captured object — the relay binding document — may be at most this many
 * UTF-8 bytes, measured before it is parsed. A first mark past it is ignored
 * and no later one is looked for.
 */
export const BRANDING_MARK_MAX_OBJECT_BYTES = 16 * 1024;

/**
 * Client-generated freshness token: at least 128 bits of randomness rendered
 * as base64url (22+ chars) or hex (32+ chars). The relay echoes it verbatim
 * inside the signed form and rejects anything else with `400`.
 */
export const DiscoveryNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);

/** Lowercase hex SHA-256 over the 65 raw public-key bytes. Also the relay's id. */
export const RelayFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const RelayIdSchema = RelayFingerprintSchema;

/**
 * Uncompressed SEC1 point `0x04‖X‖Y` (65 bytes), base64url without padding:
 * always 87 characters and, because the first byte is `0x04`, always starting
 * with `B`.
 */
export const RelayPublicKeySchema = z.string().regex(/^B[A-Za-z0-9_-]{86}$/);

/** Raw `r‖s` (IEEE P1363, 64 bytes), base64url without padding: 86 characters. */
export const DiscoverySignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

/**
 * Jellyfin's `Id` from `/System/Info/Public` — a 32-character hex GUID today,
 * bounded rather than pinned to that shape because the value is Jellyfin's and
 * the comparison is exact string equality either way.
 */
export const JellyfinServerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

/**
 * One client-reachable `/v1/ws` address. Lower `priority` is tried first.
 *
 * Exactly the socket: `ws(s)://host[:port][/base]/v1/ws` — no query, no
 * fragment, no userinfo, nothing a client would not derive itself, because the
 * client's check is string equality against the URL it is about to open.
 */
export const DiscoveryUrlSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(MAX_DISCOVERY_URL_LENGTH)
    .regex(/^wss?:\/\/[^\s?#"\\@]+\/v1\/ws$/),
  priority: z.number().int().min(0).max(1000),
});

export const MAX_DISCOVERY_URLS = 16;

/** Everything the signature covers, in the order the canonical form frames it. */
export const RelayDiscoverySignedFieldsSchema = z.object({
  schema: z.literal(DISCOVERY_SCHEMA_VERSION),
  /** Open on the wire; a verifier MUST reject any algorithm it does not implement. */
  alg: z.string().min(1).max(32),
  nonce: DiscoveryNonceSchema,
  relayId: RelayIdSchema,
  publicKey: RelayPublicKeySchema,
  /** `null` when the relay could not read the `Id` at boot. Clients fail closed on it. */
  jellyfinServerId: JellyfinServerIdSchema.nullable(),
  urls: z.array(DiscoveryUrlSchema).min(1).max(MAX_DISCOVERY_URLS),
  /** The same strings the welcome advertises (§ 3.1), at least the security-relevant ones. */
  capabilities: ServerCapabilitiesSchema,
  /** Unix seconds. */
  iat: z.number().int().nonnegative(),
  /** Unix seconds; `exp − iat ≤ DISCOVERY_MAX_LIFETIME_S`. */
  exp: z.number().int().nonnegative(),
});

export const RelayDiscoverySchema = RelayDiscoverySignedFieldsSchema.extend({
  signature: DiscoverySignatureSchema,
});

export type RelayDiscoverySignedFields = z.infer<typeof RelayDiscoverySignedFieldsSchema>;
export type RelayDiscovery = z.infer<typeof RelayDiscoverySchema>;
export type DiscoveryUrl = z.infer<typeof DiscoveryUrlSchema>;

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/**
 * Frame every field as a 4-byte big-endian byte length followed by the UTF-8
 * bytes, in one fixed order, and concatenate. Chosen over RFC 8785 JCS because
 * three languages must reproduce it byte-for-byte: length framing has no
 * number formatting, no string escaping and no key sorting to disagree on, and
 * every element is prefix-free so nested lists need only a count. Integers are
 * their shortest decimal ASCII; `null` is a zero-length field (a present
 * `jellyfinServerId` is never empty, so the two cannot collide).
 *
 * Order — the constant `DISCOVERY_CONTEXT`, then `schema`, `alg`, `nonce`,
 * `relayId`, `publicKey`, `jellyfinServerId`, the URL count then each URL's
 * `url` and `priority`, the capability count then each capability, `iat`, `exp`.
 * The signature is ECDSA P-256 over SHA-256 of these bytes.
 */
export function canonicalDiscoveryBytes(doc: RelayDiscoverySignedFields): Uint8Array<ArrayBuffer> {
  const fields: string[] = [
    DISCOVERY_CONTEXT,
    String(doc.schema),
    doc.alg,
    doc.nonce,
    doc.relayId,
    doc.publicKey,
    doc.jellyfinServerId ?? '',
    String(doc.urls.length),
  ];
  for (const entry of doc.urls) fields.push(entry.url, String(entry.priority));
  fields.push(String(doc.capabilities.length));
  for (const capability of doc.capabilities) fields.push(capability);
  fields.push(String(doc.iat), String(doc.exp));

  const encoded = fields.map((field) => utf8.encode(field));
  let total = 0;
  for (const bytes of encoded) total += 4 + bytes.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.byteLength, false);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance rules
// ---------------------------------------------------------------------------

/** Why a parsed discovery document was refused; `null` from the check means accepted. */
export type DiscoveryRejection =
  | 'alg'
  | 'signature'
  | 'nonce'
  | 'relayId'
  | 'lifetime'
  | 'expired'
  | 'not-yet-valid'
  | 'jellyfinServerId-null'
  | 'jellyfinServerId'
  | 'url';

export interface DiscoveryCheckContext {
  /** The nonce this client generated for this probe. */
  nonce: string;
  /** The client's clock, unix seconds. */
  now: number;
  /** The `Id` of the Jellyfin the user is signed in to (`/System/Info/Public`). */
  liveJellyfinServerId: string;
  /** The `/v1/ws` URL the client is about to connect to. */
  url: string;
  /** Platform crypto's answer for `signature` over `canonicalDiscoveryBytes(doc)`. */
  signatureValid: boolean;
  /** Platform crypto's lowercase hex SHA-256 of the decoded `publicKey` bytes. */
  publicKeyFingerprint: string;
}

/**
 * The rules every client applies, in this order, after the schema parse. Pure
 * so that all four clients can mirror one function and the vectors can pin
 * the verdict *and* its reason. Nothing here grants trust: a `null` verdict
 * only means the document is genuine, fresh, for this Jellyfin and for this
 * URL; whether the key is the one the branding mark names — Paired, the only
 * state — is the client's next question (§ 7 rule 9).
 */
export function checkDiscoveryDocument(
  doc: RelayDiscovery,
  ctx: DiscoveryCheckContext,
): DiscoveryRejection | null {
  if (doc.alg !== DISCOVERY_ALG) return 'alg';
  if (!ctx.signatureValid) return 'signature';
  if (doc.nonce !== ctx.nonce) return 'nonce';
  if (doc.relayId !== ctx.publicKeyFingerprint) return 'relayId';
  if (doc.exp < doc.iat || doc.exp - doc.iat > DISCOVERY_MAX_LIFETIME_S) return 'lifetime';
  if (ctx.now > doc.exp + DISCOVERY_CLOCK_SKEW_S) return 'expired';
  if (doc.iat > ctx.now + DISCOVERY_CLOCK_SKEW_S) return 'not-yet-valid';
  if (doc.jellyfinServerId === null) return 'jellyfinServerId-null';
  if (doc.jellyfinServerId !== ctx.liveJellyfinServerId) return 'jellyfinServerId';
  if (!doc.urls.some((entry) => entry.url === ctx.url)) return 'url';
  return null;
}

// ---------------------------------------------------------------------------
// Short code
// ---------------------------------------------------------------------------
//
// Since Amendment 3 (2026-09-13) the short code is no longer a trust state: it
// stays printed in the relay's boot log as an optional out-of-band check an
// operator may hand out, and Settings keeps showing the fingerprint. The
// arithmetic stays here because that is still the same eight characters, and
// the rule that a client never fetches or suggests them from the candidate
// still holds (§ 2.1).

export const SHORT_CODE_LENGTH = 8;

/** The first eight characters of the fingerprint — what an operator hands out (joint B4). */
export function shortCodeFromFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, SHORT_CODE_LENGTH).toLowerCase();
}

/** Display form, `ab12 cd34`: two groups read aloud more reliably than one. */
export function formatShortCode(code: string): string {
  const normalized = code.toLowerCase().replace(/\s+/g, '');
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 8)}`;
}

/** Whitespace and case are display concerns; anything else typed is a typo. */
export function normalizeShortCode(typed: string): string | null {
  const normalized = typed.replace(/\s+/g, '').toLowerCase();
  return /^[0-9a-f]{8}$/.test(normalized) ? normalized : null;
}

export function shortCodesMatch(typed: string, fingerprint: string): boolean {
  const normalized = normalizeShortCode(typed);
  return normalized !== null && normalized === shortCodeFromFingerprint(fingerprint);
}

// ---------------------------------------------------------------------------
// Relay binding document (§ 2.2)
// ---------------------------------------------------------------------------

/** One relay a Jellyfin's operator vouches for: its key, and where it answers. */
export const BoundRelaySchema = z.object({
  relayId: RelayIdSchema,
  publicKey: RelayPublicKeySchema,
  urls: z.array(DiscoveryUrlSchema).min(1).max(MAX_DISCOVERY_URLS),
});

/**
 * The document the branding mark carries (§ 2.3): which relay(s) belong to
 * which Jellyfin, stated by that Jellyfin's administrator. Unsigned — what
 * makes it a binding is where it is read from. A client requires
 * `jellyfinServerId` to equal the live `Id` and matches a relay by both
 * `relayId` and `publicKey` against the discovery document it verified.
 */
export const RelayBindingSchema = z.object({
  schema: z.literal(DISCOVERY_SCHEMA_VERSION),
  jellyfinServerId: JellyfinServerIdSchema,
  relays: z.array(BoundRelaySchema).min(1).max(MAX_DISCOVERY_URLS),
});

export type BoundRelay = z.infer<typeof BoundRelaySchema>;
export type RelayBinding = z.infer<typeof RelayBindingSchema>;

// ---------------------------------------------------------------------------
// Branding mark (§ 2.3)
// ---------------------------------------------------------------------------

/**
 * The line the relay prints and an administrator pastes at the end of
 * Jellyfin's Custom CSS: a CSS comment carrying the relay binding document,
 * compact, on one line. Only an administrator can write it; everyone can read
 * it, anonymously, so it is the binding that works in every topology with no
 * proxy and nothing typed.
 */
export const BRANDING_MARK_PREFIX = '/* screenfin ';
export const BRANDING_MARK_SUFFIX = ' */';
/**
 * The exact expression every client applies to `CustomCss` — the FIRST match
 * is the mark, whatever follows it. `.` does not cross a line break, so the
 * object must sit on one line; whitespace around the word and the object is
 * free. The lazy body ends at the first closing brace the comment terminator
 * follows, which for a JSON object is its own last brace: a brace inside it is
 * followed by a comma, a bracket or another brace. The vectors file states
 * these characters as text so Swift and Kotlin can be held to them.
 */
export const BRANDING_MARK_PATTERN = /\/\*\s*screenfin\s+(\{.*?\})\s*\*\//;

export function formatBrandingMark(doc: RelayBinding): string {
  return `${BRANDING_MARK_PREFIX}${JSON.stringify(doc)}${BRANDING_MARK_SUFFIX}`;
}

export type BrandingMarkRejection =
  /** No mark in the text. */
  | 'absent'
  /** The first mark's object is over `BRANDING_MARK_MAX_OBJECT_BYTES`. */
  | 'too-long'
  /** The object is not JSON. */
  | 'not-json'
  /** JSON, but not a relay binding document (`RelayBindingSchema`). */
  | 'schema';

export type BrandingMarkResult =
  | { document: RelayBinding; rejection: null }
  | { document: null; rejection: BrandingMarkRejection };

/**
 * Reference parser: the first match, the byte bound, JSON, the schema — in
 * that order, and the first failure is the answer. What comes back is a
 * relay binding document and nothing more: the caller still requires its
 * `jellyfinServerId` to equal the live `Id` and matches a relay by both
 * `relayId` and `publicKey` (§ 2.2). Never throws.
 */
export function parseBrandingMark(customCss: string): BrandingMarkResult {
  const match = BRANDING_MARK_PATTERN.exec(customCss);
  const object = match?.[1];
  if (object === undefined) return { document: null, rejection: 'absent' };
  if (new TextEncoder().encode(object).byteLength > BRANDING_MARK_MAX_OBJECT_BYTES) {
    return { document: null, rejection: 'too-long' };
  }
  let json: unknown;
  try {
    json = JSON.parse(object);
  } catch {
    return { document: null, rejection: 'not-json' };
  }
  const parsed = RelayBindingSchema.safeParse(json);
  return parsed.success
    ? { document: parsed.data, rejection: null }
    : { document: null, rejection: 'schema' };
}
