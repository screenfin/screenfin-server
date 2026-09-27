import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import { DISCOVERY_ALG, formatShortCode, shortCodeFromFingerprint } from '@screenfin/protocol';
import type { FileStorage } from './fileStore';

/**
 * The relay's persistent P-256 identity (PROTOCOL.md § 2.1).
 *
 * Generated on first boot and kept at `IDENTITY_PATH` beside the rooms
 * document, so a restart, a redeploy or a new image is still the same relay to
 * every client that pinned it. The private key never leaves that file: this
 * module hands out a `sign` function, never the key object.
 *
 * Like the rooms document, persistence is never fatal. A relay that cannot
 * write its key still answers discovery — with an ephemeral key, loudly, so an
 * operator finds out from the log rather than from every client asking them to
 * re-pair after each restart.
 */

const IDENTITY_SCHEMA_VERSION = 1;
/** Owner read/write only. Ignored where the filesystem has no modes. */
const IDENTITY_FILE_MODE = 0o600;

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The on-disk document: one JWK, the only P-256 encoding Node reads and writes without ASN.1. */
const IdentityDocumentSchema = z.object({
  schema: z.literal(IDENTITY_SCHEMA_VERSION),
  alg: z.literal(DISCOVERY_ALG),
  privateKeyJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: Base64UrlSchema,
    y: Base64UrlSchema,
    d: Base64UrlSchema,
  }),
});

type IdentityDocument = z.infer<typeof IdentityDocumentSchema>;

export interface RelayIdentity {
  readonly alg: typeof DISCOVERY_ALG;
  /** Lowercase hex SHA-256 over the 65 raw public-key bytes. */
  readonly fingerprint: string;
  /** The fingerprint, under the name the wire uses. */
  readonly relayId: string;
  /** First eight fingerprint characters — what an operator hands out (joint B4). */
  readonly shortCode: string;
  /** Uncompressed SEC1 point, base64url without padding. */
  readonly publicKey: string;
  /** False when the key could not be read or written and this boot is ephemeral. */
  readonly persisted: boolean;
  /** ECDSA P-256 / SHA-256, raw `r‖s` (IEEE P1363). */
  sign(bytes: Uint8Array): Buffer;
}

export interface RelayIdentityDeps {
  path: string;
  storage: FileStorage;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/** Lowercase hex SHA-256 of the raw point — the one derivation every platform must agree on. */
export function relayFingerprint(publicKeyRaw: Uint8Array): string {
  return createHash('sha256').update(publicKeyRaw).digest('hex');
}

function identityFrom(privateKey: KeyObject, persisted: boolean): RelayIdentity {
  // The private JWK carries the point too; only `x` and `y` leave this function.
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const fingerprint = relayFingerprint(raw);
  return {
    alg: DISCOVERY_ALG,
    fingerprint,
    relayId: fingerprint,
    shortCode: shortCodeFromFingerprint(fingerprint),
    publicKey: raw.toString('base64url'),
    persisted,
    sign: (bytes) => sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

/**
 * Read the key at `path`, or mint one and write it there.
 *
 * An unreadable document is **kept**, not replaced: it is far more likely to
 * be operator damage than anything else, and overwriting it would turn a file
 * the operator can restore from backup into a new identity every pinned client
 * has to be talked through. The boot runs ephemeral and says so.
 */
/** `node:fs` says a missing file with `code: 'ENOENT'`; anything else is a file that is there. */
function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * The persisted document as a key, or `null` for anything that is not a usable
 * P-256 key: unparsable JSON, the wrong shape, or well-formed JWK text that is
 * not a point on the curve (`createPrivateKey` throws on that, and a throw
 * here must be a warning, not a crash at boot).
 */
function keyFromDocument(text: string): KeyObject | null {
  try {
    const result = IdentityDocumentSchema.safeParse(JSON.parse(text));
    if (!result.success) return null;
    const key = createPrivateKey({ key: result.data.privateKeyJwk, format: 'jwk' });
    // Derive the point once here, so a key that parses but cannot export is
    // caught on the same path rather than one call later.
    key.export({ format: 'jwk' });
    return key;
  } catch {
    return null;
  }
}

export function loadOrCreateRelayIdentity(deps: RelayIdentityDeps): RelayIdentity {
  const { path, storage, logger } = deps;

  let existing: string | null = null;
  let unreadable: unknown = null;
  try {
    existing = storage.read(path);
  } catch (err) {
    if (isNotFound(err)) {
      existing = null; // first boot
    } else {
      unreadable = err; // present, and cannot be read: never the mint-and-write branch
    }
  }

  let identity: RelayIdentity;
  if (unreadable !== null) {
    logger.warn(
      { err: unreadable, path },
      'could not read the relay identity file; running with an EPHEMERAL key and leaving the ' +
        'file in place — fix its permissions or restore it from backup',
    );
    identity = identityFrom(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, false);
  } else if (existing !== null) {
    const key = keyFromDocument(existing);
    if (key === null) {
      logger.warn(
        { path },
        'relay identity document is unreadable; running with an EPHEMERAL key and leaving the ' +
          'file in place — restore it from backup, or delete it to mint a new identity',
      );
      identity = identityFrom(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, false);
    } else {
      identity = identityFrom(key, true);
    }
  } else {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const document: IdentityDocument = {
      schema: IDENTITY_SCHEMA_VERSION,
      alg: DISCOVERY_ALG,
      privateKeyJwk: privateKey.export({ format: 'jwk' }) as IdentityDocument['privateKeyJwk'],
    };
    let persisted = true;
    try {
      storage.write(path, `${JSON.stringify(document, null, 2)}\n`, { mode: IDENTITY_FILE_MODE });
    } catch (err) {
      persisted = false;
      logger.warn(
        { err, path },
        'could not persist the relay identity; running with an EPHEMERAL key — clients that pin ' +
          'this relay will have to pair again after the next restart',
      );
    }
    identity = identityFrom(privateKey, persisted);
    if (persisted) logger.info({ path }, 'minted a new relay identity');
  }

  // The short code is printed here and nowhere a client could fetch it from
  // (PROTOCOL.md § 16): an operator hands it out, a candidate relay never does.
  logger.info(
    { fingerprint: identity.fingerprint, persisted: identity.persisted },
    `Relay identity ${identity.fingerprint} — short code ${formatShortCode(identity.shortCode)}`,
  );
  return identity;
}
