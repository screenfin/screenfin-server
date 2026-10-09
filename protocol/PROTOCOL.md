# Screenfin Sync Protocol — v1

This document is the **language-neutral specification** of the Screenfin watch-party
synchronization protocol. It is the source of truth for every client implementation
(TypeScript, Swift, and Kotlin). The TypeScript Zod schemas in `src/` and the
generated JSON Schemas in `schemas/` are derived artifacts of this specification; if they
disagree, fix the code, not the spec's intent.

Key words **MUST**, **SHOULD**, **MAY** are used per RFC 2119.

---

## 1. Design goals

- **Server-authoritative timeline.** The sync server owns the shared playback state; clients
  converge to it. Clients never forward raw player events to each other.
- **Platform-neutral.** Standard WebSockets carrying UTF-8 JSON text frames. No JavaScript-,
  browser-, or HTMLMediaElement-specific concepts on the wire.
- **Lightweight.** The protocol carries room, timing, presence, and control messages only.
  Media bytes always flow directly between Jellyfin and each client.
- **Tolerant readers.** Receivers MUST ignore unknown fields inside objects. Unknown message
  _types_ are an error (see § 6.4).
- **Capability negotiation.** Clients discover optional server behavior from
  `session.welcome.payload.capabilities`; the envelope version is not a feature gate.

## 2. Transport

- Externally reachable endpoints MUST use WebSocket over TLS (`wss://`). Plain `ws://` is allowed
  only for localhost or a private network behind a TLS-terminating reverse proxy.
- Endpoint: `GET /v1/ws` on the sync server.
- Frames are JSON **text** frames, one message per frame. Binary frames MUST be rejected.
- Maximum frame size: **64 KiB**. Larger frames MAY be dropped and the connection closed
  with close code `4000`.
- Credentials MUST NOT appear in the URL (no token query parameters). Authentication happens
  in-band via `session.hello` (§ 7).

### 2.1 Relay identity and signed discovery (`relay.identity`)

A relay has one persistent **P-256** key. Before a client sends anything it would mind a
stranger holding — and a Jellyfin access token is exactly that — it asks the candidate relay to
prove which key it holds, and checks that key against what it already trusts (§ 7 rule 9). The
endpoint is credential-free, stateless, and one round trip:

```
GET /v1/discovery?nonce=<nonce>
```

- `nonce` is **client-generated**, at least 128 bits of randomness rendered as base64url (22+
  characters) or hex (32+); the accepted form is `[A-Za-z0-9_-]{22,128}`. A missing or malformed
  nonce is `400`. The relay echoes it verbatim inside the signed form, so a captured response
  cannot answer a later probe.
- The response is `application/json` with `Cache-Control: no-store` and `Pragma: no-cache`. The
  relay never follows or issues redirects here; a client MUST NOT follow one, MUST bound the read
  at **16 KiB** (`DISCOVERY_MAX_RESPONSE_BYTES`) and MUST bound the time.
- Requests are rate-limited per client address (`DISCOVERY_RATE_LIMIT_PER_IP` per minute, `429`)
  under the same proxy-trust policy as every other pre-authentication limit (§ 16).
- No `Authorization` header is sent or read. The document carries no credential, no token, and
  never the relay's `JELLYFIN_URL` (§ 16).

The document (`schemas/relay-discovery.schema.json`; Zod `RelayDiscoverySchema`):

| Field              | Type                      | Meaning                                                                                                                                                                              |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`           | `1`                       | Document schema version.                                                                                                                                                             |
| `alg`              | string                    | `"ES256"` — ECDSA P-256 with SHA-256. A verifier MUST reject any `alg` it does not implement.                                                                                        |
| `nonce`            | string                    | The request's nonce, verbatim.                                                                                                                                                       |
| `relayId`          | 64 lowercase hex          | The relay's fingerprint (below). Stable across addresses; changes only with the key.                                                                                                 |
| `publicKey`        | 87-char base64url         | Uncompressed SEC1 point `0x04‖X‖Y`, 65 bytes, base64url without padding (so it starts with `B`).                                                                                     |
| `jellyfinServerId` | string or `null`          | The `Id` from `GET <JELLYFIN_URL>/System/Info/Public`, read at boot. `null` if it could not be.                                                                                      |
| `urls`             | `[{url, priority}]`, 1–16 | Every client-reachable socket this relay advertises, each exactly `ws(s)://host[:port][/base]/v1/ws` (≤ 512 chars; no query, fragment or userinfo); lower `priority` is tried first. |
| `capabilities`     | string list               | The strings `session.welcome` will advertise (§ 3.1) — at least the security-relevant ones.                                                                                          |
| `iat`, `exp`       | unix **seconds**          | Issue and expiry; `exp − iat ≤ 60` (`DISCOVERY_MAX_LIFETIME_S`). The reference relay uses 30 s.                                                                                      |
| `signature`        | 86-char base64url         | Raw **`r‖s`** (IEEE P1363, 64 bytes), base64url without padding, over the canonical form below.                                                                                      |

**Canonical form.** The signature covers every field except `signature`, in one fixed order,
each field framed as a 4-byte big-endian byte length followed by its UTF-8 bytes, concatenated:

```
frame(s) = uint32be(len(utf8(s))) ‖ utf8(s)

bytes = frame("screenfin/relay-discovery")          -- domain-separation constant
      ‖ frame(schema) ‖ frame(alg) ‖ frame(nonce) ‖ frame(relayId) ‖ frame(publicKey)
      ‖ frame(jellyfinServerId or "")                -- null is a zero-length field
      ‖ frame(count(urls)) ‖ for each url: frame(url) ‖ frame(priority)
      ‖ frame(count(capabilities)) ‖ for each: frame(capability)
      ‖ frame(iat) ‖ frame(exp)
```

Integers are their shortest decimal ASCII (`"1"`, `"30"`, `"1757700000"`). The signature is
ECDSA P-256 over **SHA-256 of these bytes**. Length framing was chosen over RFC 8785 JCS
because three languages must reproduce the bytes exactly: it has no number formatting, no string
escaping and no key sorting to disagree on, every field is prefix-free, and there is no JCS
library on Swift or Kotlin to lean on. The leading constant means a relay key that later signs
something else can never produce bytes that also verify as a discovery document.
`canonicalDiscoveryBytes` in `src/discovery.ts` is the reference encoder.

**Fingerprint and short code.** `relayId` is the lowercase hex SHA-256 of the **65 raw
public-key bytes** — never of the base64url text. The **short code** is its first eight
characters, displayed as two groups (`ab12 cd34`); comparison ignores case and whitespace. It is
not a trust state (§ 7 rule 9): the relay prints it in its boot log as an optional out-of-band
check an operator may hand out — a person can hold it against the fingerprint every client's
Settings shows — and that is the only place it may come from. A client MUST NOT fetch or suggest
it from the candidate itself, not from this document and not from `/healthz`, because a
self-reported code proves nothing.

**Verification** — every client applies these rules in this order after the schema parse, and
`checkDiscoveryDocument` in `src/discovery.ts` is the reference (its result names the rule):

1. `alg` is one the client implements (`alg`).
2. `signature` verifies over the canonical form with `publicKey` (`signature`).
3. `nonce` equals the one this client generated for this probe (`nonce`).
4. `relayId` equals the client's own SHA-256 of the decoded `publicKey` (`relayId`).
5. `iat ≤ exp` and `exp − iat ≤ 60` (`lifetime`).
6. `now ≤ exp + 300` (`expired`) and `iat ≤ now + 300` (`not-yet-valid`). The **±300 s** skew
   allowance (`DISCOVERY_CLOCK_SKEW_S`) exists for televisions: a set-top box fresh from a cold
   boot or on an isolated LAN can be minutes off, and the nonce, not the clock, is what defeats
   replay.
7. `jellyfinServerId` is not `null` (`jellyfinServerId-null`) and equals the `Id` of the Jellyfin
   the user is signed in to (`jellyfinServerId`). A relay that could not read its `Id` is not
   bound to anything, so the client fails closed.
8. The URL the client is about to connect to is in `urls` (`url`).

A `null` verdict means the document is genuine, fresh, for this Jellyfin and for this URL —
nothing more. Which trust state applies is § 7 rule 9.

**Test vectors.** `test/vectors/relay-discovery.vectors.json` carries two TEST-ONLY keys and
seven documents — valid, tampered after signing, wrong nonce, expired, wrong `Id`, second key,
`null` `Id` — each with its exact canonical bytes as hex, its signature, and the expected verdict
and reason. `test/vectors/relay-binding.vectors.json` carries the two document cases of § 2.2
(the object the mark carries), and `test/vectors/branding-mark.vectors.json` the twelve
`CustomCss` cases of § 2.3 —
the marks that parse and, more usefully, the ones that must not. Every implementation MUST pass
all of them; `scripts/generate-discovery-vectors.ts` regenerates the signed two (only the
randomized signatures change).

**Platform notes.** Node: `crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y },
format: 'jwk' })` from the point's X and Y, then `verify('sha256', bytes, { key, dsaEncoding:
'ieee-p1363' }, sig)`. WebCrypto: import the raw 65-byte point with `{ name: 'ECDSA', namedCurve:
'P-256' }` and verify with `{ name: 'ECDSA', hash: 'SHA-256' }` — it already takes `r‖s`. Swift:
`P256.Signing.PublicKey(x963Representation:)` and
`P256.Signing.ECDSASignature(rawRepresentation:)`, then `isValidSignature(_:for:)` over the bytes
(it hashes with SHA-256 itself). Kotlin/Android (API 26+): rebuild the point with
`ECPublicKeySpec(ECPoint(x, y), secp256r1 params)`, and note that `Signature.getInstance(
"SHA256withECDSA")` consumes **DER** — convert `r‖s` to a DER `SEQUENCE` of two `INTEGER`s
(minimal, with a leading `0x00` when the high bit is set) before `verify`.

**Advertised URLs.** The reference relay advertises `ADVERTISED_URLS` (a comma-separated list,
`priority` in list order) when set — each entry validated and normalised at boot to the form a
client derives (lower-case scheme and host, default port dropped, ending in `/v1/ws`, nothing
after it), at most 16 entries whose serialised form stays under 8 KiB so the whole document
stays inside the 16 KiB a client reads, and the relay refuses to start otherwise; otherwise it
derives one URL from the request it is answering
— `wss://` when the request arrived over HTTPS (directly, or via `X-Forwarded-Proto` under the
configured `TRUST_PROXY` policy), `ws://` otherwise, the request's effective host, and `/v1/ws`.
A relay published under a path prefix or on more than one address MUST set `ADVERTISED_URLS`;
a derived URL can only ever name the address the client already used.

### 2.2 The relay binding document

The document that states which relay(s) belong to a Jellyfin, written by that Jellyfin's
administrator. It is what the **branding mark** of § 2.3 carries, and the mark is the only place a
client reads it from (Amendment 4, 2026-09-13; § 7 rule 9). It is **unsigned** — what makes it a
binding is _where_ it is read: from the signed-in Jellyfin itself, which only an administrator can
write to.

```json
{
  "schema": 1,
  "jellyfinServerId": "2351b368e12e40e487cdd3bd9fbbdcd1",
  "relays": [
    {
      "relayId": "<fingerprint>",
      "publicKey": "<base64url SEC1 point>",
      "urls": [{ "url": "wss://screenfin.example/v1/ws", "priority": 0 }]
    }
  ]
}
```

(`schemas/relay-binding.schema.json`; Zod `RelayBindingSchema`, one entry `BoundRelaySchema`;
Swift and Kotlin `RelayBindingDocument`.) `jellyfinServerId` is the Jellyfin's `Id` as
`/System/Info/Public` reports it; each relay entry is that relay's fingerprint, its public key and
its advertised `/v1/ws` URLs in priority order (§ 2.1), at most `MAX_DISCOVERY_URLS` relays and
URLs each. **Acceptance:** `jellyfinServerId` MUST equal the live `Id`, and a relay is matched by
**both** `relayId` and `publicKey` against the discovery document already verified — a relay that
answers with a key the document does not name is refused (_"your Jellyfin server names a different
relay"_). `test/vectors/relay-binding.vectors.json` carries the two document cases.

> **History.** This document was first specified as a static file the Jellyfin origin served at
> `/.well-known/screenfin`, and was named for it. Amendment 4 (2026-09-13) removed that read from
> every client — neither such a file nor a `/screenfin` route on the Jellyfin origin makes a relay
> trusted — and the relay no longer prints or serves one; the rename to _relay binding document_
> followed the same day. The object bound that file's read carried (16 KiB) survives as
> `BRANDING_MARK_MAX_OBJECT_BYTES`.

**The web client's share is a notice, not a gate.** Its socket is derived from the page origin and
base path, and that origin is its root of trust: JavaScript
served by a malicious origin can steal its own credentials whatever the page checks. So the web
verifies its own origin's discovery document and reads the § 2.3 mark only to catch **honest
misconfiguration** — a page relay bound to a different Jellyfin, or one the mark does not name —
shows a standing, non-blocking notice, and connects anyway. It does not read this file
(Amendment 4). This MUST NOT be described as protection against the serving origin.

### 2.3 Branding mark (`/Branding/Configuration`)

The recommended binding, and the one that works in every topology — a bare LAN, VLANs, separate
domains, an external IP — with no proxy and nothing typed on a device. Only a Jellyfin
administrator can write it; every client can read it anonymously. Decided as Amendment 3 of the
relay-trust design adopted 2026-09-13.

The relay prints one line — at boot, and again whenever it learns its Jellyfin's `Id` — a CSS
comment carrying the **relay binding document of § 2.2**, compact, on one line:

```
/* screenfin {"schema":1,"jellyfinServerId":"2351b368e12e40e487cdd3bd9fbbdcd1","relays":[{"relayId":"<fingerprint>","publicKey":"<base64url SEC1 point>","urls":[{"url":"wss://screenfin.example/v1/ws","priority":0}]}]} */
```

There is **no new schema**: the object is `RelayBindingSchema` (§ 2.2), unchanged, and the mark's
`urls` are `ADVERTISED_URLS` (§ 2.1), so an operator sets that first. The administrator pastes the
line at the end of **Dashboard → General → Branding → Custom CSS** and saves. Jellyfin keeps it in
`BrandingOptions.CustomCss`, which is:

- **readable by anyone** — `GET <jellyfin-base>/Branding/Configuration` answers `200` with no
  credentials (measured on 12.0.0), as `{ "LoginDisclaimer", "CustomCss", "SplashscreenEnabled" }`,
  and with `Access-Control-Allow-Origin: *`, so the web client reads it cross-origin without any
  proxy configuration;
- **writable only by an administrator** — an anonymous `POST /System/Configuration/Branding` is
  `401` (measured).

The relay never writes it. No Jellyfin API key is created, stored or accepted (§ 16); Screenfin
never administers Jellyfin; the one thing that moves is a line of text an administrator pastes.

**How a client reads it.** After sign-in: `GET <jellyfin-base>/Branding/Configuration`,
credential-free, `no-store`, no redirects, the body bounded at **1 MiB**
(`BRANDING_MAX_RESPONSE_BYTES` — far larger than the other bounds on purpose, because the mark is
appended _after_ whatever theme the administrator already pasted, and a theme pasted inline runs to
hundreds of KiB). Take `CustomCss` (a string; anything else is no mark) and apply, exactly:

```
/\*\s*screenfin\s+(\{.*?\})\s*\*/
```

1. The **first** match is the mark. Nothing after it is consulted, even when the first one fails.
2. `.` does not cross a line break on any platform, so the object must sit on **one line**;
   whitespace around the word and the object is free. The lazy body ends at the first closing
   brace a comment terminator follows, which for a JSON object is its own last brace.
3. The captured group is at most **16 KiB of UTF-8** (`BRANDING_MARK_MAX_OBJECT_BYTES`), measured
   before it is parsed.
4. Parse it as JSON, then as the relay binding document. Unknown fields are ignored, as everywhere.
5. Then exactly § 2.2's acceptance: `jellyfinServerId` MUST equal the live `Id`, and a relay is
   matched by **both** `relayId` and `publicKey` against the discovery document already verified.

Any failure — no match, too long, not JSON, not the schema, another Jellyfin's `Id` — means _no
mark_, silently: the client treats the Jellyfin as saying nothing, and nothing a stranger can put
in a page is an error a client shows. `parseBrandingMark` in `src/discovery.ts` is the reference
(its result names the step that failed: `absent`, `too-long`, `not-json`, `schema`), and
`test/vectors/branding-mark.vectors.json` carries twelve cases every client MUST pass, with the
expression above spelled as its `pattern` (JavaScript escapes the two slashes as `\/`; the
characters are otherwise the same on every platform).

**One list.** The mark's `relays` array is the whole of a client's relay list: there is no second
declaration anywhere to unite it with, and a relay that answers discovery with a key the mark does
not name is refused (§ 2.2 acceptance). The mark is the lock of § 7 rule 9.

## 3. Versioning

- Every sender MUST emit `"version": 1`. This emitted value is permanently frozen and is not
  bumped for wire evolution.
- A receiver MUST validate `version` as a positive integer, but MUST NOT use its numeric value
  as a compatibility gate. If a known message type has a compatible payload, the receiver
  processes it even when the envelope carries a positive integer other than `1`.
- Missing, non-integer, or non-positive versions are ordinary schema violations and follow the
  `INVALID_MESSAGE` behavior in § 6.4. They do not have a distinct close path.
- After the coordinated pre-v1 clean break represented by this document, wire evolution is
  **additive in place**: never rename/remove a field, make an optional field required, or change
  existing message semantics. New optional behavior is advertised with stable capability strings
  in `session.welcome`.
- Clients and servers MUST tolerate unknown optional fields and unknown capability strings.

### 3.1 Server capabilities

Servers MUST emit `session.welcome.payload.capabilities`, a list of strings describing optional
behavior implemented by that server. Capability names are stable once published. Receivers
MUST preserve or safely ignore unknown names, and MUST treat an absent list as empty for
compatibility with pre-capability relays; they MUST NOT reject the welcome. The list is bounded
to 128 names of 1–128 characters each.

The current relay advertises exactly these independently detectable features:

| Capability                        | Meaning                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `session.resume`                  | Reconnect with a server-issued resume token and retain room membership. |
| `lobby.open-parties`              | Receive the configured-Jellyfin open-party lobby push.                  |
| `room.display-name`               | Create and render optional human-readable room names.                   |
| `room.settings`                   | Read and change control/buffering room settings.                        |
| `room.host-transfer`              | Transfer host ownership to another participant.                         |
| `playback.queue`                  | Synchronize an ordered playback queue.                                  |
| `playback.buffering-coordination` | Coordinate buffering and readiness across participants.                 |
| `room.started-at`                 | `RoomState.startedAt` is populated (§ 8): a lobby is distinguishable.   |
| `lobby.maturity-filtered`         | `lobby.state` is filtered for the receiving session (§ 8.1).            |
| `relay.identity`                  | Signed `GET /v1/discovery` (§ 2.1) and `session.welcome.payload.relay`. |
| `room.removed`                    | The relay removes a seat stuck buffering and says why (§ 13.4).         |

`lobby.maturity-filtered` is the other one, for the same kind of reason: a roster that omits a
party this account may not watch is byte-identical to a roster that simply has no such party. A
client that has it can say _"some parties are hidden by your Jellyfin's parental controls"_ rather
than _"no parties"_, knows that `RoomState.playback` carries `maturityRating` and `containsUnrated`
(§ 8), and knows that `room.join` may answer `FORBIDDEN` for that reason rather than only for a
permission it can see. Without it a client must assume an unfiltered roster, which is what every
relay before this one sent. The display pair is **not** on `LobbyGroup`: the level is shown inside
the room, never on the open-room card.

`room.started-at` is the one capability a client cannot infer from behavior, which is why it is
advertised at all. Swift and Kotlin decode an absent key and an explicit `null` to the same `nil`,
so without it a receiver cannot tell a relay reporting _"this party has not begun"_ from a relay
that has never heard of `startedAt` — and every room reads as not started. A relay built from this
table that omits it will be misread by every Screenfin client.

The baseline handshake, room lifecycle, playback timeline, position reporting, clock sync,
acks, and errors are core protocol behavior and are deliberately not duplicated as
capabilities.

### 3.2 Tolerant-reader audit

The v1 implementations were audited across all three clients. TypeScript uses ordinary Zod
objects for envelopes and payloads, which accept and strip unknown keys; Swift `Codable`
ignores keys absent from its `CodingKeys`; and Kotlin uses one shared `Json` decoder with
`ignoreUnknownKeys = true`. Regression fixtures in every implementation add unknown fields at
both envelope and payload levels. Receivers therefore accept additive object fields without
requiring a version change.

There is exactly one deliberate exception: `session.hello.payload.auth` is a strict object.
It contains exactly `jellyfinToken`; any unknown key MUST reject the hello as `INVALID_MESSAGE`.
In particular, legacy asserted-identity keys (`serverUrl`, `userId`, `userName`) must not be
silently stripped. This security exception applies only to `auth`; the surrounding hello payload
and envelope remain tolerant readers.

## 4. Message envelope

Every message in both directions:

```json
{
  "version": 1,
  "id": "8f14e45f-ceea-4e07-8c2f-1f6f7a3d9b21",
  "type": "room.join",
  "roomId": "a1b2c3d4",
  "replyTo": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "sentAt": 1710000000000,
  "payload": {}
}
```

| Field     | Type    | Direction            | Rules                                                                                                                   |
| --------- | ------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `version` | integer | both                 | Senders MUST emit `1`; receivers accept any positive integer and do not gate compatibility on its value.                |
| `id`      | string  | both                 | Unique per message. Senders SHOULD use UUID v4. Used for idempotency and ack correlation.                               |
| `type`    | string  | both                 | Namespaced message type (see catalogs).                                                                                 |
| `roomId`  | string  | both                 | REQUIRED on room-scoped messages; absent on session-scoped ones. `[A-Za-z0-9_-]{4,64}`.                                 |
| `replyTo` | string  | server → client only | The `id` of the client message being answered. REQUIRED on `ack`; present on `error` when the failing request is known. |
| `sentAt`  | integer | both                 | Sender's clock, unix epoch **milliseconds**. Informational; clock sync uses § 10, not this field.                       |
| `payload` | object  | both                 | Message-specific body, always an object (possibly empty).                                                               |

Timestamps and media positions are **always milliseconds** (Jellyfin's 100 ns "ticks" are
converted at the Jellyfin-adapter boundary and never appear on the wire).

## 5. Identifiers

- **sessionId** — issued by the server in `session.welcome`; identifies one authenticated
  WebSocket session. The **participantId of a session is its sessionId** (they are the same
  value by definition; the spec uses the two names only to signal context).
- **resumeToken** — opaque secret (≥ 128 bits entropy) paired with a sessionId for resumption.
- **roomId** — server-generated, short, URL-safe, shareable.
- **itemId** — Jellyfin item id; opaque to the sync server.
- A Jellyfin user MAY hold multiple concurrent sessions (two browser tabs = two participants
  with the same `userId`).

## 6. Reliability model

### 6.1 Acknowledgements

Every client → server message except `sync.ping` receives **exactly one** response: an `ack`
(success) or an `error` (failure), correlated via `replyTo`. `sync.ping` is answered by
`sync.pong` (correlated by `payload.clientTime`, not `replyTo`).

`ack.payload.room` carries a full room snapshot when the request produced one
(`room.create`, `room.join`).

### 6.2 Retries and idempotency

- If a client receives no ack/error within `ackTimeoutMs`, it MAY re-send the message with
  the **same `id`** (at most 2 retries), then surface a connection problem.
- The server keeps a small per-session LRU (≥ 64 entries) of processed message ids with their
  serialized responses. A duplicate id MUST NOT be re-applied; the cached response is re-sent.
  An ack that carried a room snapshot (`room.create`, `room.join`) is the exception to "the same
  bytes": the reference relay does not keep the snapshot, and answers the duplicate with the room
  **as it is now** — or with no `room` at all when the session has since left it. The room is the
  same one either way; only its revision may have moved on, which § 6.3 already tolerates.

### 6.3 Revisions and ordering

- Every room mutation increments `revision` by exactly 1; every `room.state` broadcast carries
  the **full** room snapshot with its revision (no deltas in v1).
- Clients MUST apply a snapshot only if `revision` is greater than the last applied revision
  and silently drop stale/duplicate snapshots. Because snapshots are complete, a skipped
  revision is harmless; a client that suspects it missed traffic (e.g. after resume) SHOULD
  send `room.stateRequest`.
- Concurrent commands from multiple users are serialized by server arrival order;
  the commands are absolute (explicit positions/items), so last-writer-wins is convergent.

### 6.4 Invalid traffic

- Malformed JSON / schema violations → `error` with `INVALID_MESSAGE` (`replyTo` set when an
  id could be extracted). Repeated violations MAY escalate to a close with code `4000`.
- Messages before authentication completes (other than `session.hello`) → `NOT_AUTHENTICATED`.
- Commands the sender is not permitted to issue → `FORBIDDEN` (§ 9).
- Rate limiting: servers SHOULD apply a per-session token bucket (default 20 msg/s, burst 40;
  `client.position` and `sync.ping` counted against a separate, more generous bucket) and
  answer overflows with `RATE_LIMITED` (`retryable: true`).
- Per-account limits. Some commands cost the relay, or Jellyfin, more than a frame, so the
  reference relay also bounds them per Jellyfin **account** — every session of that account
  shares one budget — and answers overflows with the same `RATE_LIMITED` (`retryable: true`), with
  a sentence a client MAY show:
  - `room.create`: a burst of 5, then 10 a minute. An account holds at most `MAX_ROOMS_PER_USER`
    rooms (default 5), live and idle; at the cap, a create **retires that account's own
    longest-idle room** (it disappears from the lobby as any removed room does, § 8.1) and is
    refused only when every room the account holds has somebody in it. The relay holds at most
    `MAX_ROOMS` rooms in all (default 200, at most 1,000).
  - `queue.set` and `playback.setItem`, together: a burst of 5, then 2 a second.
  - Item ids **new to the room** in those two commands: 2,000 a minute. Ids the room already
    holds are free, so reordering or trimming a queue costs nothing here.
    A client SHOULD treat these like any `RATE_LIMITED`: say so and let the user try again, not
    retry in a loop.
- Slow readers. A socket that stops reading while it keeps sending is bounded too: once the
  server's queue for it passes a soft limit (1 MiB in the reference relay), superseded snapshots —
  `lobby.state` and `room.state` — are skipped for it; a frame that would take it past a hard limit
  (4 MiB), or a queue that stays past the soft one for `clientTimeoutMs`, closes the socket, and
  the session enters its ordinary reconnect grace (§ 13.3). A skipped `room.state` is a skipped
  revision, which § 6.3 already makes harmless.

## 7. Authentication & session lifecycle

The user authenticates with **Jellyfin directly**. Each self-hosted sync server is bound to one
administrator-configured Jellyfin base URL and verifies the client's saved access token with
`GET <configured-base>/Users/Me`. The client never chooses the relay's upstream destination.
The relay derives `userId` and `userName` solely from that response, and nothing else from it.

This verification establishes identity inside the coordination plane; it does not grant media
access or replace Jellyfin authorization. Media still flows directly Jellyfin → client, and
Jellyfin evaluates that client's token for every media request.

```
Client                             Sync server                     Jellyfin
  │  (authenticates directly)                                           │
  │────────────────────────────────────────────────────────────────────▶│
  │◀────────────────────────────────────────────────────────────── token│
  │  WSS connect /v1/ws                 │                               │
  │────────────────────────────────────▶│                               │
  │  session.hello {jellyfinToken}      │                               │
  │────────────────────────────────────▶│  GET /Users/Me (MediaBrowser) │
  │                                     │──────────────────────────────▶│
  │                                     │◀──── verified user / 401/403 │
  │◀─ session.welcome {sessionId, resumeToken, user, syncConfig, capabilities}
```

Rules:

1. The client MUST send `session.hello` as its **first** message, promptly after connecting;
   otherwise the server closes with `4003`. The window is server-configurable
   (`HELLO_TIMEOUT_MS`, default 10 s), so clients MUST NOT rely on the exact value — send the
   hello immediately on open rather than budgeting against it. A socket that has not sent its
   hello can also be closed with `4003` **early**, when more unauthenticated sockets from its
   address (or in all) are waiting than the server admits: the reference relay then closes the
   **oldest** such socket to admit the new one, rather than refusing the newcomer, so one client
   holding idle sockets cannot lock everyone behind the same address out. A socket whose hello
   is already being validated is never closed for this. `auth` MUST contain exactly one
   field, `jellyfinToken` (1–512 printable ASCII characters, excluding `"` and `\`). Unknown
   keys, including legacy `serverUrl`, `userId`, and `userName`, MUST produce `INVALID_MESSAGE`.
2. The server validates the token using `Authorization: MediaBrowser ...` against exactly
   `<operator-configured-base>/Users/Me`, with redirects disabled and bounded timeout/body size.
   It MUST NOT make a request to any client-supplied address. A `200` response is parsed
   defensively for `Id` and `Name`; the rest of the body, `Policy` included, is not read.
   `401`/`403` produces terminal `AUTH_FAILED`; network errors and upstream `5xx` produce
   retryable `AUTH_UNAVAILABLE`. The configured base URL is syntactically validated at boot but
   is not probed, so temporary Jellyfin unavailability does not crash-loop the relay. Before a
   Jellyfin `Name` is placed on the wire, the relay removes the scalars forbidden by the display
   name schema, trims surrounding whitespace, and truncates to the 64-UTF-16-unit limit without
   splitting a grapheme. If nothing remains, it derives a deterministic wire-safe fallback from
   the verified user id.
3. On success the server stores the raw token only in private memory on the live session for
   revalidation. Tokens MUST NOT be logged or persisted. A bounded validation cache MAY be used,
   but raw tokens MUST NOT be cache keys; the reference relay uses SHA-256 digests.
4. The server periodically revalidates live sessions. A `401`/`403` result (or a response whose
   user id no longer matches) emits terminal `AUTH_EXPIRED` and closes with `4002`. A transient
   validation failure keeps the session for a later sweep. Successful revalidation updates the
   session's user name.
5. On success the server sends `session.welcome` containing `sessionId`, `resumeToken`, the
   verified user, `serverTime`, the effective `syncConfig` (§ 12 defaults), and the server's
   `capabilities` (§ 3.1).
6. **Resume:** after a disconnect, the client reconnects and sends `session.hello` with the
   `resume` payload (old `sessionId` + `resumeToken`) plus its current Jellyfin token. The server
   MUST validate that token first. Within `reconnectGraceMs` of the disconnect it restores the
   session (same sessionId/participantId, room membership intact) and replies
   `session.welcome` with `resumed: true` and, if applicable, the current `room` snapshot.
   Resume MUST fail with `SESSION_RESUME_FAILED` if the validated user id differs from the
   existing session, the resume token mismatches (constant-time comparison), or the grace period
   elapsed. It MUST NOT attach on failure. Successful resume replaces the stored token and user
   name. Resume does not create another session and MAY cross IP addresses.
7. If a session with a live socket is resumed from a new socket, the server MUST close the
   old socket with `4004` and attach the session to the new one.
8. **`session.welcome` MUST be the first server frame written to a connection.** No `room.state`,
   `lobby.state` or any other room-scoped frame may reach a socket before it, and a resume MUST NOT
   broadcast a participant's own reconnect back to the socket it is resuming — that snapshot travels
   inside the welcome instead. Clients MUST ignore any room frame that arrives beforehand.

   The reason is that such a frame is uninterpretable by construction: the receiver has no
   `syncConfig`, no capability list and no session, so it cannot even decide whether a `startedAt`
   of `null` means "not started" or "this relay predates the field" (§ 8.1). A client that trusts it
   anyway adopts a room it is about to be told nothing about. Attaching the socket before the
   membership update was exactly this bug: an iOS relaunch received the room it was in, opened that
   room's screen, and then the welcome behind it — which correctly gives a relaunched seat up —
   cleared the room out from under a screen that was already on display, leaving "the party ended"
   over a party that was still running.

9. **Trust before token.** A client MUST NOT send `session.hello` — or any credential — to a
   relay until it has fetched and verified that relay's discovery document (§ 2.1: signature,
   `jellyfinServerId` equal to the live Jellyfin's `Id`, the URL it is about to use) **and** the
   key is the one the signed-in Jellyfin's **branding mark** names. There is exactly one trust
   state (Amendment 4, 2026-09-13, which replaced Amendment 3's two and the earlier four):

   | State      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | **Paired** | On every launch and every connect/reconnect the client reads the signed-in server's `/Branding/Configuration`, extracts the first `/* screenfin {…} */` comment from `CustomCss` (§ 2.3 — bounded; _no mark_ if it does not parse against the well-known schema or its `jellyfinServerId` differs from the live `Id`), rewrites its pin (key + URL list) from the mark **before** probing, then probes the listed URLs in priority order, verifies the discovery signature under the listed key, `Id` match, URL match → connect, **no prompt of any kind**. The mark needs no https: Jellyfin's own access control is what protects it. Settings shows _"Managed by your Jellyfin server"_, a Fingerprint row (the eight-character short code) and a Status row, and names no address anywhere. |

   **The mark is the only source of relay information**, in every topology, including local use.
   There is no manual relay entry, no trust-on-first-use path, no legacy acknowledgement, no
   `screenfin.<domain>` suggestion, and neither a `/screenfin` route nor a `/.well-known/screenfin`
   file is a binding on any client (§ 2.2). **The stored pin never outlives the mark**: a launch or
   reconnect that finds no mark drops the pin and connects to nothing. What the user sees is one of
   three sentences:

   - **No mark** — _"No relay information found in your Jellyfin server. Please follow the
     Screenfin relay server setup instructions."_ Onboarding offers **Continue** and parties stay
     off; Settings shows the same sentence under the Watch parties toggle, which may be on (the
     user's intent) — the client pairs by itself the moment a mark appears.
   - **Mark present, discovery proof `not-yet-valid`** — _"This device’s date and time appear to be
     incorrect. Check them, then try again."_ Onboarding preserves **Retry** and **Continue anyway**;
     Settings shows that same actionable sentence and the client keeps retrying on later launches
     and connects.
   - **Mark present, relay unreachable or otherwise not verifying** — _"Can't reach the relay
     server. Please verify it is running."_ Onboarding offers **Retry** and **Continue anyway**;
     Settings shows Status _"Not connected — can't reach the relay server"_ and the client keeps
     retrying on later launches and connects. A relay that answers with a key the mark does not
     list, or an `Id` that is not the signed-in Jellyfin's, is a distinct failure — _"Your Jellyfin
     server names a different relay"_ / _"belongs to a different Jellyfin server"_ — and is never
     accepted.

   The short code is not typed anywhere; it stays printed at boot (§ 2.1) and is the Fingerprint
   row's value. Nothing had shipped when the states were collapsed, so nothing is grandfathered:
   an address a client stored under an earlier model is discarded, not migrated.

   The pin — key, URL list, the Jellyfin `Id` it was read for — is stored keyed by Jellyfin `Id`
   and is only ever written from the mark, so a different Jellyfin never inherits it. A relay
   whose discovery names a **different** `Id` is refused before hello with _"belongs to a
   different Jellyfin server"_, whatever its address. `session.welcome.payload.relay` (`{ relayId,
jellyfinServerId }`, optional, only from relays advertising `relay.identity`) lets the client
   confirm that the socket it holds belongs to the key it verified; a mismatch is treated like a
   failed signature. Old clients ignore the field; old relays never send it.

## 8. Room state model

The complete room snapshot (`schemas/room-state.schema.json`):

```jsonc
{
  "roomId": "a1b2c3d4",
  "name": "Movie night", // or null
  "createdAt": 1710000000000,
  "startedAt": 1710000030000, // or null — first play; never cleared
  "revision": 42, // monotonically increasing, +1 per mutation
  "hostParticipantId": "sess-1",
  "settings": {
    "controlMode": "everyone", // or "host-only"
    "bufferingPolicy": "pause-all", // or "ignore"
  },
  "playback": {
    "itemId": "jf-item-1", // or null
    "queue": [{ "itemId": "jf-item-1" }, { "itemId": "jf-item-2" }],
    "queueIndex": 0, // or null
    "maturityRating": "PG-13", // or null — display only, never the gate
    "containsUnrated": false, // a second axis, not a low rating
    "state": "playing", // idle | playing | paused | waiting
    "positionMs": 90000, // authoritative position at measuredAt
    "measuredAt": 1710000100000, // server clock when positionMs was true
    "rate": 1,
  },
  "participants": [
    {
      "participantId": "sess-1",
      "userId": "jf-user-1",
      "userName": "alice",
      "role": "host", // host | guest
      "connection": "connected", // connected | reconnecting
      "playerState": "playing", // idle|loading|ready|playing|paused|buffering
      "lastPositionMs": 90050, // or null
      "lastReportAt": 1710000099000, // or null
      "joinedAt": 1710000000000,
    },
  ],
}
```

**Timeline invariant.** The authoritative position at server time `t` is:

```
state == "playing":  positionMs + (t − measuredAt) × rate
otherwise:           positionMs
```

Every mutation that touches the timeline first materializes the current expected position
into `positionMs`/`measuredAt`, then applies the change. `waiting` is identical to `paused`
except that it was entered by the buffering policy and exits automatically (§ 13).

**The clock stops at the end when nothing is next**. When the room is `playing` an item
whose runtime the server knows and the queue holds **no next entry** — `queue[(queueIndex ?? -1) + 1]`
is absent, the same reading every client's end-of-item stage makes — the server stops the timeline
when the projection reaches the runtime: one `room.state` with `state: "paused"` and
`positionMs` equal to the runtime, caused by `playback.pause` **with no `participantId`**, so no
client announces it as somebody's pause (§ 9.2). The room stays there until somebody acts on it;
the host's next `playback.setItem` or `queue.set` behaves as always, and a participant joining in
between loads the room paused at the end rather than past it. **With a next entry the server does
nothing**: the host's client advances the room, and a server that paused first would
race it. The server learns the runtime from Jellyfin's answer to the visibility question it already
asks (§ 8.1 — `RunTimeTicks` on the same `/Items?userId=…&ids=…` response), never from a client and
never by a request of its own; when it has none — not answered yet, none carried, `0` for live TV —
the timeline projects exactly as above, unbounded. `playback.setItem` still carries no duration,
and a client MUST NOT assume a relay stops at the end: one predating this rule
does not, and one that cannot learn the runtime does not either.

**`playback.maturityRating` and `playback.containsUnrated` are for display and are never the gate.**
`maturityRating` is **what constrains the room**: when any seated participant's Jellyfin account
has a maturity ceiling (`/Users/Me` → `Policy.MaxParentalRating`), it is the **lowest such ceiling**,
named by the server's own ladder — the first `GET /Localization/ParentalRatings` entry whose value
equals it (`7` → `TV-Y7` on a US-locale server), or the bare number when no entry does; when no
seated participant has a ceiling, it is the highest `OfficialRating` name over the room's media —
the current item **and** the whole queue — or `null` when nothing rated is known. **It moves with the
roster**: a server MUST re-derive it on join, leave, grace expiry and host transfer as well as on
`playback.setItem` and `queue.set`, and a client that draws it MUST follow every `room.state`, because
the seat that lowers it may leave. `containsUnrated` is true when any item carries no effective
rating, and is a fact about the media alone. They sit beside `queue` because they summarize it:
the level is the ceiling over the room rather than the rating of what is on screen, which is also
why it does not flicker as the queue advances. Unrated is a **second axis rather than a low
rating** — Jellyfin's `BlockUnratedItems` is per user, so one account sees unrated items and another
with the same ceiling does not. Measured by setting `BlockUnratedItems: ["Movie"]` on a
test account and restoring it: `NR`, `Not Rated` and `Unrated` were withheld alongside items
carrying no rating at all, while `16+`, `M`, `G` and `TV-MA` stayed visible — so those three names
belong on this axis and a server MUST NOT count them toward `maturityRating`.

A client MUST NOT re-derive visibility from these fields: the comparison is not expressible from
them, and the gate is the per-session filtering and the join refusal of § 8.1. The ceiling itself is
never on the wire — only the ladder's name for it — and a server holds it as it holds the token: in
the live session, never persisted, never logged. A server ordering the media rule's maximum SHOULD
use `GET /Localization/ParentalRatings`' `RatingScore` (`score`, then `subScore`), with a name that
ladder does not score sorting **above** every name it does — `16+` and `M` are exactly such names in
a real library and are blocked at ceilings that permit low-rated ones, so treating one as low is
the unsafe way to be wrong about a label.

**They are on the room snapshot rather than on `LobbyGroup` (§ 8.1), and that placement is the
decision, not an accident.** The room's level is not shown on the open-room card; it is shown inside
the room. A client holds a `LobbyGroup` only _before_ it joins and a `RoomState` once it is in, so
this is where the fact is read. A relay that also advertised it on the roster would be offering the
card the pair exists to keep off.

**Started vs. created (`startedAt`).** A room created with an `item` sits at `state: "paused"`,
`positionMs: 0` until somebody plays it. That is byte-for-byte what a room looks like when a host
seeks back to the start and pauses, so the timeline cannot answer "has this party begun?".
`startedAt` answers it: `null` until the room's timeline first goes live, then the server clock at
that moment. Clients use it to decide whether a room is still gathering or already watching. It is
a fact about the party, not about the timeline; read `playback.state` for the latter.

**It is a one-way latch for the life of a _party_, not of a room.** It is not cleared by pausing,
by seeking to zero, or by a relay restart — none of those mean the party stopped. Servers MUST
clear it back to `null` in exactly two cases, both of which return the room to being a lobby:

1. the room losing its **last** participant (the idle freeze in § 8 — the room stays listed and
   joinable, and whoever walks back in is starting rather than arriving late); and
2. **`playback.setItem`**, because a different film has not begun.

The playback position is deliberately **not** reset alongside it, so walking back into an emptied
room resumes where the room was.

This was a permanent latch until clients grew a lobby screen, at which point "this party began"
became true forever. Clients read `startedAt` for two decisions — what a Start control means (play
for everybody, or walk me into a film already running) and whether a room appearing should open the
player, the latter being a `false` → `true` **transition** that a permanently-`true` field can never
make again. The result was a room that could be started together exactly once: after everyone left
and rejoined, every device drew the walk-in button, and pressing it moved that one device into a
paused film and told nobody else.

"Goes live" means `playing` **or** `waiting`, and the second is not a technicality. A `play` that
lands while a participant's last report was `buffering` is held by the pause-all policy in the same
mutation that started it (§ 13.1), so the room's first live state is `waiting` and no `playing`
snapshot is ever broadcast for it. A relay that latched only on `playing` would report
`startedAt: null` for a room whose timeline had already begun, and every client would sit in the
lobby of a running party until the hold timed out.

A relay predating this field omits it. A client MUST treat an absent `startedAt` as
`createdAt` when `playback.itemId` is non-null and as `null` otherwise — under the older model a
room holding an item was a room already watching, and reviving it as though it had never begun
would strand its participants ahead of a film already in progress.

> Not to be confused with the **lobby** of § 8.1, which is this relay's directory of joinable
> rooms. `startedAt` concerns one room's own history.

**Jellyfin namespace.** Every authenticated session, room, and lobby entry belongs to the one
Jellyfin configured for that relay. `RoomState` therefore carries no server URL. An `itemId`
is interpreted within that configured namespace.

**Host.** Exactly one participant is `host`. The host can always control playback, change
settings, edit the queue, transfer host, and close the room. With `controlMode: "everyone"` any
participant may issue playback commands; `queue.set`, `room.setSettings`, `room.transferHost`, and
`room.close` remain host-only. **`controlMode` governs starting and pausing, not what the room
watches next**: an overloaded "control playback" that silently also meant "change the film"
is a surprise in the direction that costs a room its evening, so editing the queue is the host's
whatever `controlMode` says.

**A non-host may _step_ through the queue and may not _jump_ outside it**. `playback.setItem`
is not host-only — pressing **Next** is a control an `everyone` room grants a guest — but its
`itemId` MUST name an entry `playback.queue` already holds, and the server answers `INVALID_STATE`
otherwise. The host is not stepping through anything, so the queue does not bind them. **A room whose
queue is empty therefore refuses a non-host's `playback.setItem` outright**, which is the rule rather
than a gap in it: a room created with an initial item has no queue, and the alternative reading —
"empty queue, allow anything" — would leave the arbitrary-film hole open for the commonest shape a
party takes. All permission checks are enforced server-side. The one exception is
an idle room (below): with `participants: []` there is no host, `hostParticipantId` names whoever
held it last, and the next participant to join becomes host.

**A returning host takes the chair back.** A room that loses its host — it empties, or it comes
back off durable storage — remembers the Jellyfin **user id** that held it, and the first join
from that account takes the host role, whether or not somebody else has already revived the room.
Anyone else joining an empty room still hosts it, exactly as above; the memory only decides who
holds the chair once its owner returns. It is spent by that reclaim, and cancelled outright by an
explicit `room.transferHost` — a human deciding who should host outranks a remembered answer,
where the automatic paths do not, because they are the reconnect-order accident this corrects.
The reclaim broadcasts as an ordinary `participant.joined`; the new `hostParticipantId` and the
demoted `role` travel in the same snapshot, so no client needs a second cause to read it.

**Idle rooms.** A room whose last participant leaves is NOT destroyed. It is frozen — the
timeline is materialized and a `playing`/`waiting` room becomes `paused`, so an unattended
party does not run on — and kept for a server-configured window (`EMPTY_ROOM_TTL_MS`, default
15 minutes), then removed. It stays listed in the lobby throughout, with
`participantCount: 0`. This is what makes a page reload, a lost connection past
`reconnectGraceMs`, or a relay restart recoverable: the party is still there to rejoin. A
client MUST therefore accept a `RoomState` with an empty `participants` array, and MUST NOT
infer from a lobby entry that anyone is watching — check `participantCount`.

### 8.1 Lobby (open-party discovery)

The open-party set is every room on the relay, including the idle ones waiting out
their removal window (§ 8) — an entry with `participantCount: 0` is how someone walks back
into the party they just left, so it is listed, not hidden. The server advertises this set to
every authenticated session with the **push-only**
`lobby.state` message (§ 9.2): there is no client request for it. The server sends it once as
part of (or right after) `session.welcome`, and again — unsolicited — whenever the open-party set
changes (a room is created, gains/loses a participant, changes its media through
`playback.setItem` or `queue.set`, goes idle, or is removed). The server MAY coalesce a burst of
such changes: the reference relay pushes the first change of a quiet period at once and the rest
within at most 250 ms, in one push that describes the roster as it then is. The media case is what keeps `itemId`
from going stale, and it is what makes the per-session filtering below arrive on time;
`playback.play`/`pause`/`seek` and `client.position` deliberately do not push a roster, because they
change nothing a `LobbyGroup` carries.

**A frame carries at most 200 groups** (`MAX_LOBBY_GROUPS`), and the server MUST truncate to that
rather than emit a longer list. The number bounds how long a list a client is required to render,
not the frame: a group is roughly 112 bytes, so 200 of them is about 22 KB against the 64 KiB cap
of § 2. Truncation is not arbitrary and clients may rely on its order: **rooms with participants
are listed first**, then idle rooms **most recently emptied first**, and it is idle rooms that are
dropped. An idle room is the affordable loss — nobody is in it, and it is already counting down to
removal — while a room being watched must remain joinable. A relay below the cap lists every room
it holds, in its own order. A client MUST NOT treat this list as an exhaustive directory: a
`room.join` for a `roomId` that never appeared in `groups` is still valid, which is what makes
rejoin-by-id work whether or not the room made the cut.

Each `groups[]` entry is a lightweight summary (`roomId`, `name`, `hostName`, `participantCount`,
`capacity`, `itemId`) — enough to render a joinable list and a live count; a client joins a listed
party with an ordinary `room.join` carrying its `roomId`. `hostName` is never empty: an idle room
advertises the name of the host it had last. It carries **no maturity level**: that is shown inside
the room, on `RoomState.playback` (§ 8), not on the card.

**The roster is per session, not per relay.** A server advertising `lobby.maturity-filtered` MUST
omit, from one session's `groups`, every room holding media that session's Jellyfin account may not
see — and MUST refuse that account's `room.join` for such a room with `FORBIDDEN`. Both are
required: a `room.join` for a `roomId` that never appeared in `groups` is still valid (above), so
hiding cannot be the enforcement, and the two doors together hold one invariant — **the room's
media never exceeds any seated participant's ceiling**, guarded at the join and at the add
(`queue.set`, `playback.setItem`; § 9.1).

Watchability is a property of the **whole queue**, not of `itemId`: a room whose current film is
permitted and whose next entry is not must be omitted, or it would be offered, joined, and hit the
wall one item later — and a room hidden today would reappear the moment the queue advanced.

**A failure to resolve is not a refusal, but an unasked question is not a resolution.** These are
two different states and they get two different answers.

A server that _asked_ and could not get an answer — a network blip, a Jellyfin `5xx` — MUST list the
room and MUST allow the join. Hiding legitimate parties would turn a visible lie into an invisible
one, and hiding is not the enforcement in any case: Jellyfin refuses the media itself to an account
that may not have it. These rules protect the experience; the media server protects the viewer.

A server that has **not asked yet** has resolved nothing, and MUST NOT read that as permission. A
server resolving lazily MUST omit such a room from that session's `groups` and MUST refuse the join
or the add with `VISIBILITY_PENDING` (§ 14) — never `FORBIDDEN`, which asserts a settled answer
about the account and would have a client tell someone they were blocked for their maturity ceiling
when nobody had looked. The refusal is _retryable_, and a server making it MUST begin resolving the
answer it lacked, so that the same frame retried a moment later is decided rather than refused
again. A server that resolves eagerly, before it answers, never emits the code at all.

The asymmetry is durability, not caution. An unreachable Jellyfin heals on its own and a hidden
party comes back; a seat taken before the check ran is permanent, because nothing re-evaluates a
room once somebody is in it.

**The display-only summary of the room's media is on the room snapshot, not here.** § 8 defines
`playback.maturityRating` and `playback.containsUnrated`, and states why neither is ever the gate.
The filtering above is; a client that re-derived visibility from a label would be wrong.

**`participantCount` counts occupied seats, except that a room nobody is attending reports 0.**
A participant whose socket drops keeps its seat for `reconnectGraceMs` (§ 11) and stays in
`RoomState.participants` as `reconnecting` — the seat is genuinely reserved, and `room.join` will
refuse at `capacity` accordingly. But when **every** remaining participant is `reconnecting` the
room reports `participantCount: 0`, because this field is also the only liveness signal a client
outside the room has: `participantCount > 0` is what marks a party live. Without the exception, a
party everybody had closed advertised a watcher for the whole grace window and anyone answering it
walked into an empty room. A _partially_ disconnected room still reports its full seat count, so a
full room keeps reading full rather than inviting a join the relay would then refuse. The server
MUST push a fresh `lobby.state` when a room crosses that boundary in either direction — the
transition is what a client is watching for, and it happens a minute before the participants are
actually removed. Because the message is a
tolerant-reader broadcast of current state (not a delta), a client always replaces its whole
lobby view with the latest `groups`.

### 8.2 Relay settings

Settings come in two tiers that MUST NOT be conflated.

**Per-room** (`RoomSettings`: `controlMode`, `bufferingPolicy`) is the host's, scoped to one
room, chosen on `room.create`, changed with `room.setSettings`, and carried in every
`room.state`. A `room.create` MAY omit either field or both; the relay fills what was omitted
with `DEFAULT_ROOM_SETTINGS` — **`host-only`, `pause-all`** — so a host who chose nothing keeps
control of the party they started and waits for a buffering participant. That fallback is the
protocol's, mirrored by every client (`RoomSettings.defaults` / `DEFAULTS`), and **there is no
operator override for it**: the choice is the host's, and an operator value behind a per-party
choice would be a second source of truth for it. (the relay-settings rule briefly made it two
environment variables,
`DEFAULT_CONTROL_MODE` and `DEFAULT_BUFFERING_POLICY`; its amendment removed them.)

**Relay-wide** is the operator's, set in the relay's environment and nowhere else:

| Variable                | Meaning                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `MAX_ROOM_PARTICIPANTS` | Largest number of participants a room accepts (1–100; the ceiling bounds `RoomState.participants`). |

**There is no wire surface for it — no read, no write.** A client that wants to know the value
asks the operator; what a client can observe is where it acts: `maxRoomParticipants` as the
`capacity` of a lobby group and as `ROOM_FULL`. Earlier revisions carried `server.getSettings` /
`server.setSettings`, an `ack.serverSettings` field, a `server.settings` capability and a
persisted settings document that won over the environment; all were removed in the same day's
work as Amendment 4, and nothing had shipped, so nothing is grandfathered. A relay answers
those message types like any unknown type: `INVALID_MESSAGE`.

**When changes take effect.** `MAX_ROOM_PARTICIPANTS` is checked at each `room.join` and is fixed
for the life of the process: a change is edit the environment, restart. Participants are never
persisted (§ 8.3), so a restart cannot leave a room above a lowered cap.

**Not included on purpose.** `SyncConfig` (§ 12) is likewise environment-only, because a
plausible-sounding drift threshold silently degrades playback for every client in every room.

### 8.3 Room durability

Rooms survive a relay restart. The relay writes them to durable storage and reads them back at
boot, so updating the container interrupts a party instead of ending it.

What comes back is a room in the idle state of § 8: sockets do not survive a restart, so a
restored room has no participants and a frozen timeline at the position it held when the relay
went down. Its removal window keeps running across the outage — a relay that was down longer
than `EMPTY_ROOM_TTL_MS` restores nothing — and whoever rejoins first becomes host, until the
account that held the chair when the relay went down rejoins and takes it back (§ 8). The host's
user id is the one thing about membership that is persisted; the roster is not, for the reason
above.

Consequences for clients:

- A shutdown sends **no** `room.closed`. Clients see an ordinary disconnect, reconnect with
  their usual backoff, fail `resume` (session state is not persisted, only rooms), and SHOULD
  rejoin their previous room by id, exactly as § 7.6 already requires after a failed resume.
  `room.closed {reason: "server-shutdown"}` is sent only when the relay could not save its
  rooms, and then it means what it says: the party is over.
- A relay persists at most 1,000 rooms — live rooms first, then the most recently emptied — and
  reads back at most that many, dropping a room that fails validation rather than the whole
  document. `MAX_ROOMS` cannot be set above it, so nothing the relay accepted is lost to the limit.
- A restored room's `revision` jumps forward by a margin, because a client may have applied
  revisions produced after the last snapshot reached storage and would otherwise discard the
  restored state as stale (§ 6.3). Clients MUST NOT depend on revisions being contiguous — they
  are ordered, not dense — and SHOULD reset their revision gate when a snapshot arrives from an
  explicit `room.join`/`room.create` ack or `session.welcome`.

### 8.4 One device per room, per account

A Jellyfin account holds **at most one seat in any one room**. A `room.join` from a second device
of an account already seated in that room is refused with `JOINED_ON_ANOTHER_DEVICE`, and the
message names the other device where it can — `session.hello.payload.client.deviceName`, which the
relay retains on the session for this and does not put on the wire.

Two things the rule deliberately does **not** restrict:

- **The same account in two different rooms from two devices is allowed.** The check looks only
  inside the room being joined.
- **`room.create` is untouched.** Opening a second party from a second device is not the case this
  is about.

**The exception, which is not optional.** The refusal applies only while the other session still
holds a **live socket**. A session inside its `reconnectGraceMs` window has no socket — a
television that lost wi-fi — and its seat is released so the joining device takes it over: the
membership is removed exactly as the expiring grace timer would have removed it. Refusing there
would tell a viewer to go and leave the party on a device that is offline, which is an instruction
nobody can obey; and the relay makes the same judgement about a socketless session holding a slot
against `MAX_SESSIONS_PER_USER`.

**The chair goes with the person**. When the released seat held host, the
joining session holds it in the same revision, and no other seat holds it even for one snapshot.
Host passes to another seat only when the grace runs out — after a dropped socket, or after the
host's own `room.leave` (§ 13.3).

**The takeover is one revision.** When anyone else is still in the room, the released seat and the
joining one are swapped in a **single** `room.state`: the reconnecting seat is gone from
`participants` and the new one is there, under `participant.joined` naming the new seat — also when
the released seat held the chair, because the chair stayed with the same person and there is nothing
about it to announce (before the returning-host rule this was `host.changed` naming the released
seat, and the seat
that inherited the chair drew "Became host"). There is no separate `participant.left`. This is how a
person comes back inside the grace from a session that has no resume credential — a new browser tab,
a relaunched app — and it is a return, not a departure and an arrival: clients read a join whose
account held a `reconnecting` seat that the same snapshot no longer carries as that return, and
announce nothing. A room the release would empty still idles first and
is revived by the join, as before; nobody is left in it to tell, and the joining session hosts the
revived room.

`JOINED_ON_ANOTHER_DEVICE` is distinct from `ALREADY_IN_ROOM` and clients MUST NOT merge them.
`ALREADY_IN_ROOM` means _this session_ is in a room, and the recovery for it is to leave that room
and retry. The refused session here is in no room at all, so that recovery would send a
`room.leave` for a room it is not a member of; surface the message instead.

The check runs **before** the `ROOM_FULL` capacity check, for two reasons: releasing a dead
session's seat can make a full room joinable, and where both refusals are true the viewer can only
act on this one.

## 9. Message catalog

### 9.1 Client → server

| Type                | Scope   | Payload (all fields validated)                                                                                    | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.hello`     | session | `client {platform, appVersion, deviceName?}`, `auth {jellyfinToken}` (strict), `resume {sessionId, resumeToken}?` | First message; authenticate or resume (§ 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sync.ping`         | session | `clientTime`                                                                                                      | Clock sync + liveness (§ 10). Answered by `sync.pong`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `room.create`       | session | `name?`, `settings?` (partial), `item {itemId, positionMs?}?`                                                     | Create a room; sender becomes host. Ack returns the snapshot. With `item`: playback starts `paused` at `positionMs ?? 0`; without: `idle`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `room.join`         | room    | `{}`                                                                                                              | Join an existing room as `guest`. Ack returns the snapshot; others receive `room.state` (`participant.joined`). Fails: `ROOM_NOT_FOUND`, `ROOM_FULL`, `ALREADY_IN_ROOM` (a session is in ≤ 1 room), `JOINED_ON_ANOTHER_DEVICE` (§ 8.4). `FORBIDDEN` when the room's media is above this account's Jellyfin maturity ceiling (§ 8.1); checked before every other refusal, so it has no side effect.                                                                                                                                                                                                       |
| `room.leave`        | room    | `{}`                                                                                                              | Leave. A guest is removed at once. A **host** who leaves while anyone else is seated keeps the chair for `reconnectGraceMs`: the session is out of the room immediately, but its seat stays `reconnecting` and returns the chair to the same account if it rejoins in time; otherwise the earliest-joined watching seat is promoted (§ 13.3, the host-promotion rule). The last participant leaving does **not** close the room: it goes idle and stays listed and joinable for `EMPTY_ROOM_TTL_MS` (§ 8, § 13.3), and only then closes with `room.closed {reason:"empty"}` — which by definition reaches nobody. |
| `room.close`        | room    | `{}`                                                                                                              | Host only. Broadcasts `room.closed {reason:"host-closed"}` to all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `room.stateRequest` | room    | `reason?`                                                                                                         | Ask for a fresh snapshot; server sends `room.state` (`cause: state.request`) to the requester only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `room.setSettings`  | room    | `settings` (partial)                                                                                              | Host only. Broadcast cause `settings.changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `room.transferHost` | room    | `toParticipantId`                                                                                                 | Host only; target must be a participant. Broadcast cause `host.changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `playback.play`     | room    | `positionMs?`                                                                                                     | User intent. Requires a selected item (`INVALID_STATE` otherwise). Timeline → `playing`; `positionMs` defaults to the current authoritative position.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `playback.pause`    | room    | `positionMs?`                                                                                                     | User intent. Timeline → `paused`, frozen at `positionMs ??` current authoritative position.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `playback.seek`     | room    | `positionMs`                                                                                                      | User intent. Sets the authoritative position; playing/paused state unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `playback.setItem`  | room    | `itemId`, `positionMs?`, `queueIndex?`                                                                            | Switch media. A **non-host's `itemId` MUST be an entry `playback.queue` already holds** (`INVALID_STATE` otherwise; § 8), so an empty queue refuses a non-host outright. Timeline → `paused` at `positionMs ?? 0`; clients load the item and report `client.ready`. `FORBIDDEN`, naming them, when a **seated** participant's Jellyfin account may not see `itemId` (§ 8.1) — the add is refused, never the person. `queueIndex` is stored as sent, never range-checked.                                                                                                                                 |
| `queue.set`         | room    | `items[]`, `queueIndex?`                                                                                          | Host only, whatever `controlMode` says (§ 8). Replace the whole queue (idempotent full write; no incremental ops in v1). `queueIndex` accepts an explicit `null`, which CLEARS the index; omitting it preserves the current index (clamped if the new queue is shorter). `FORBIDDEN`, naming them, when a seated participant may not see any entry in the new queue (§ 8.1).                                                                                                                                                                                                                             |
| `client.position`   | room    | `positionMs`, `playerState`, `rate?`                                                                              | Periodic status report (every `positionReportIntervalMs`). **Never** interpreted as a command. Updates the sender's participant entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `client.buffering`  | room    | `buffering`, `positionMs?`                                                                                        | Buffering edge-trigger; drives the buffering policy (§ 13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `client.ready`      | room    | `itemId`                                                                                                          | The client finished loading `itemId` and can start instantly. Ignored (acked, no effect) if `itemId` no longer matches the room's current item.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Playback commands (`playback.*`, `queue.set`) are **user intents**. Synchronization
corrections (§ 12) MUST NOT be sent as commands.

### 9.2 Server → client

| Type              | Payload                                                                                                                  | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.welcome` | `sessionId`, `resumeToken`, `user {id,name}`, `serverTime`, `syncConfig`, `capabilities[]`, `resumed`, `room` (nullable) | Session established (§ 7). Servers always emit `capabilities` with open strings (§ 3.1), while readers treat an absent field from a pre-capability relay as `[]`. `room` is always PRESENT: the current snapshot on a resume that rejoined a room, otherwise `null`.                                                                                                                                                             |
| `ack`             | `room?`                                                                                                                  | Positive response; `replyTo` REQUIRED. `room` on `room.create`/`room.join`; `serverSettings` on `server.getSettings`/`server.setSettings`.                                                                                                                                                                                                                                                                                       |
| `error`           | `code`, `message`, `retryable`, `details?`                                                                               | Negative response or async fault; `replyTo` set when known (§ 14).                                                                                                                                                                                                                                                                                                                                                               |
| `room.state`      | `room` (full snapshot), `cause {type, participantId?}`                                                                   | Broadcast to all connected participants on every mutation; also the reply channel for `room.stateRequest`. `room.playback` carries the display-only `maturityRating`/`containsUnrated` pair (§ 8), which is never the gate.                                                                                                                                                                                                      |
| `room.closed`     | `reason` (`host-closed` \| `empty` \| `server-shutdown`)                                                                 | Terminal for the room; clients drop local room state. `empty` reaches nobody in practice (the room has no participants left by then), and `server-shutdown` is sent only by a relay going down that could not persist its rooms (§ 8.3).                                                                                                                                                                                         |
| `room.removed`    | `reason` (`stalled`; open string)                                                                                        | Sent to **one** seat, the one the relay took out of the room, before the room's `room.state` drops it (§ 13.4). `roomId` REQUIRED. The session is no longer a member afterwards, as after `room.leave`; the client says why and MUST NOT rejoin that room by itself (joining again by hand is allowed). The room itself carries on.                                                                                              |
| `sync.pong`       | `clientTime` (echo), `serverTime`                                                                                        | Clock-sync answer (§ 10).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lobby.state`     | `groups[] {roomId, name, hostName, participantCount, capacity, itemId}`                                                  | Push-only roster of the open parties **this session's account may see** (§ 8.1), at most 200 groups, live rooms first. It carries **no** maturity level — that is on `RoomState.playback` (§ 8), shown inside the room rather than on the card. `participantCount` is 0 for a room whose every participant is `reconnecting`. Sent unsolicited at welcome and on every open-party change; **not** a reply to any client message. |

`cause.type` values: `room.created` (reserved — room creation is answered by an `ack`
snapshot and produces no broadcast, so no current server emits it), `participant.joined`,
`participant.left`,
`participant.updated`, `host.changed`, `playback.play`, `playback.pause`, `playback.seek`,
`playback.setItem`, `queue.set`, `settings.changed`, `buffering.waiting`,
`buffering.resumed`, `state.request`. A `playback.pause` with no `participantId` is the server
stopping the clock at the end of the item (§ 8), not anybody's press. A `participant.left` or
`host.changed` carrying `cause.reason` is the server **removing** `participantId` rather than the
seat leaving (§ 13.4) — the same open reason string `room.removed` carries, so every other seat
can say why that person went; a departure the seat chose never carries one. Receivers MUST treat unknown cause values as an
opaque "state changed" (tolerant reader) — causes are for UX (toasts), never for state logic.
Client-side message schemas therefore accept any non-empty string for `cause.type`; a
`room.state` frame carrying a future cause value MUST NOT be dropped.

## 10. Clock synchronization

Clients estimate the offset between their clock and the server clock with an NTP-style
exchange every `pingIntervalMs`:

```
t0 = client clock when sync.ping sent      (payload.clientTime)
t1 = server clock when sync.pong produced  (payload.serverTime)
t3 = client clock when sync.pong received

rtt    = t3 − t0
offset = t1 − (t0 + rtt/2)        // serverNow ≈ clientNow + offset
```

Clients SHOULD keep a sliding window (≈ 10 samples), discard negative-RTT samples, and use
the **median offset of the lowest-RTT half** (≤ 5 samples) so latency spikes don't skew the
estimate (reference implementation: `src/clock.ts`). Wall-clock jumps (NTP steps, suspend)
are absorbed naturally as new samples arrive; clients MAY reset the window when they detect
a discontinuity.

## 11. Position reporting

While a media item is loaded, every client sends `client.position` each
`positionReportIntervalMs` with its local position and player state. These reports feed
presence UI and server-side observability. The server updates the sender's participant entry
immediately, and broadcasts the change with cause `participant.updated`.

That broadcast is **coalesced**: reports arrive from every participant on the same cadence and
describe the same unchanged timeline, so the server collects a window of them (at most
`positionReportIntervalMs`) into one `room.state` rather than sending N snapshots to N
participants. Presence can therefore lag a report by up to one interval, which is why presence
is never load-bearing for synchronization: the timeline lives in `playback`, and anything that
changes it — commands, buffering (§ 13.1), readiness — is broadcast on arrival, carrying any
pending presence with it.

A report that **changes the sender's `playerState`** (`loading` → `ready`, `ready` → `playing`,
into or out of `buffering`) is not coalesced either: it is what a host watches the roster for,
so the server broadcasts it on arrival, carrying any pending presence. To keep a seat that flaps
between states from flooding the room, the server takes that path at most once per short window
per seat (the reference relay uses 500 ms); a further change inside the window is deferred to
the window's end rather than to the full interval. Only position-only reports wait out the
coalescing window. The wire is unchanged — the cause is still `participant.updated`.

The same window bounds the seat's `client.buffering` and `client.ready` reports that change only
its `playerState`: one on-arrival broadcast per window, shared across all three messages, and the
window's end carries the seat's last word. The timeline edges of § 13.1 keep their own causes and
are bounded there.

## 12. Drift detection & correction

Each client runs a correction loop (≈ 2× per second) while in a room with a loaded item:

1. `serverNow = clientNow + offset` (§ 10).
2. `expected = expectedPositionMs(playback, serverNow)` (§ 8 invariant).
3. `drift = localPosition − expected` (positive = ahead).
4. Apply, per thresholds from `syncConfig`:
   - `|drift| ≤ driftIgnoreMs` → no action; if a rate adjustment is active, restore rate 1.
   - `driftIgnoreMs < |drift| < driftHardMs` and timeline is `playing` → temporary
     rate adjustment: `rate × (1 − rateCorrection)` when ahead, `rate × (1 + rateCorrection)`
     when behind; keep until drift falls under `driftIgnoreMs`, then restore.
   - `|drift| ≥ driftHardMs`, or the timeline is frozen (`paused`/`waiting`) → hard seek to
     `expected`.
5. Reference implementation: `planDriftCorrection` in `src/timeline.ts`.

**Feedback-loop rule.** Corrections (seeks, rate changes) initiated by this loop are applied
to the local player only and MUST NOT be reported as user commands. Client architectures
MUST separate the two paths: UI intent → send command → wait for `room.state`; sync
correction → local player only. A client SHOULD also suppress drift evaluation briefly
(≈ 1 s) after applying its own hard seek, and after applying a new snapshot, to let the
player settle.

### Default tuning (`syncConfig`, server-configurable)

| Field                      | Default | Meaning                                                   |
| -------------------------- | ------- | --------------------------------------------------------- |
| `pingIntervalMs`           | 5000    | Clock-sync/liveness cadence.                              |
| `positionReportIntervalMs` | 2000    | `client.position` cadence.                                |
| `driftIgnoreMs`            | 150     | Dead zone; no correction.                                 |
| `driftHardMs`              | 1500    | Hard-seek threshold.                                      |
| `rateCorrection`           | 0.05    | ±5 % catch-up/slow-down.                                  |
| `ackTimeoutMs`             | 3000    | Client re-send window (§ 6.2).                            |
| `clientTimeoutMs`          | 30000   | Server drops silent connections.                          |
| `reconnectGraceMs`         | 60000   | Resume window (§ 7.6) and presence grace (§ 13.3).        |
| `bufferingMaxWaitMs`       | 0       | Max `waiting` hold per buffering participant; 0 = no cap. |

## 13. Buffering, readiness, presence

### 13.1 Buffering (`bufferingPolicy: "pause-all"`, default)

- A participant reports `client.buffering {buffering: true}` while the room is `playing` →
  the server freezes the timeline (`state: "waiting"`, cause `buffering.waiting`). All
  clients pause locally as a sync correction.
- A `playback.play` under `pause-all` also holds for every connected participant whose last
  recorded `playerState` is `buffering`, since the edge is not repeated once the room plays. That
  record may have come from a `client.position` alone, so a participant can be waited on without
  ever having sent `buffering: true`.
- A participant stops being waited on when it reports `buffering: false`, **or** sends a
  `client.position` whose `playerState` is anything but `buffering` (the held-seat release: the
  report is the
  recovery, and a held seat that never sent the edge has no `buffering: false` to send).
- When every buffering participant has stopped being waited on — or has been waited on
  for `bufferingMaxWaitMs`, or leaves/disconnects, or is removed for being stuck (§ 13.4) — the
  server resumes. **A hold ends at the latest when the held seat is removed**: a seat that stays
  `buffering` for the relay's removal delay (one minute by default) is taken out of the room, and
  that departure is the resume. A disconnect ends the
  wait at once, whatever the reconnect grace: a participant that cannot report is not
  buffering. `bufferingMaxWaitMs: 0` (the reference relay's default) is **no cap** — the hold
  then lasts until the participant recovers, leaves or disconnects. ~~The host's start-anyway
  is the manual escape.~~ There is **no** manual escape from a seat that goes on reporting
  `buffering`: Start anyway is the lobby's, and a mid-play `playback.play` re-arms the
  hold on every connected seat whose last `playerState` is `buffering` (bullet 2), the host's own
  included — so the rule below, and the removal of § 13.4, are what end such a hold. On resume: `state: "playing"`, `measuredAt = now`. The cause is
  `buffering.resumed`, EXCEPT when the resume was triggered by someone leaving or
  disconnecting: that broadcast carries the presence cause of the triggering event
  (`participant.left` / `participant.updated` / `host.changed`) instead, since it is one
  snapshot describing both changes. Clients MUST therefore treat any snapshot with
  `state: "playing"` as authoritative rather than waiting for `buffering.resumed`
  specifically. A participant that timed out catches up via hard seek when it recovers.
- **`buffering` means "expects to recover by waiting".** A client MUST NOT report `buffering`
  (in `client.buffering` or as a `client.position` `playerState`) for a player that has failed —
  a media or decode error it will not come back from by itself. When its player fails, a client
  MUST clear the report on that edge (`buffering: false`, if `buffering: true` was sent) and go on
  reporting a non-`buffering` `playerState`, so the hold ends. A client MAY first try to recover
  (reload or re-attach the stream at the position) and report `buffering` while that attempt
  runs, provided the attempt is bounded. Under the no-cap default nothing else ends such a hold:
  H4 (hardware party 2) held a room in `waiting` for 182 s on a web seat whose element had failed
  with `MEDIA_ERR_DECODE`, until the page was reloaded.
- A seat freezes the room at most once per short window (the reference relay uses the § 11
  window, 500 ms). A `buffering: true` from a seat that already froze the room inside its window
  is not dropped: the server holds the room at the window's end if that seat's last report is
  still `buffering`, with cause `buffering.waiting`. The resume is never delayed. A client that
  debounces its buffering edge, as every client does, never meets this.
- With `bufferingPolicy: "ignore"`, reports only update presence; the room keeps playing. A seat
  that stays stuck is still removed after the same delay (§ 13.4).

### 13.2 Readiness

After `playback.setItem` (and on join), clients load the item and send
`client.ready {itemId}`. The **server** does not gate playback on readiness — `playback.play`
is accepted whatever the roster says, and the message is specified so a future
`autoplay-when-all-ready` room setting needs no protocol change. Every **client** does: the
lobby's Start is drawn from "is every participant connected and loaded", so the three rules
below are what stop one seat holding a whole party shut.

**Readiness is a level, not an edge.** A client MUST go on asserting its player state for as
long as it holds the room's item, on the `client.position` cadence of § 11, rather than
reporting it once when the item changed. The server's copy does not survive the seat being
re-created: every `room.join` builds the participant at `playerState: "idle"`, including the
rejoin-by-id that follows a server restart and the join that follows an expired
`reconnectGraceMs`. A client that reports only on the edge therefore goes permanently
un-ready after any reconnect, with nothing on any device able to clear it (measured
across three clients).

**A client that cannot load the item reports ready anyway.** Resolution or loading may fail
for reasons that are not faults — a Jellyfin parental ceiling answers `404` for an item other
participants can see — and a seat that stays silent is one every other participant's Start
button waits on forever, with no way to overrule it. The failure belongs on that client's own
screen, not in a control nobody else can explain. Its subsequent `client.position`
reports MUST keep claiming `ready`, or the next one withdraws the claim.

**Readiness is per item.** `client.ready` carries `itemId` and the server drops it when the
room has moved on; clients MUST NOT claim readiness for an item the room is no longer on.

### 13.3 Presence, timeouts, host handover

- A connection with no inbound traffic for `clientTimeoutMs` is considered dead and closed. So is
  one that keeps sending but stops **reading** (§ 6.4).
- A disconnected participant is kept in the room as `connection: "reconnecting"` for
  `reconnectGraceMs`, then removed (cause `participant.left`).
- If the **host** disconnects, host role transfers after the same grace period (cause
  `host.changed`). **If the host leaves explicitly, so does it**: while
  anyone else is seated, `room.leave` from the host takes the session out of the room at once —
  it is sent nothing more from it and may join another — and leaves its seat behind as
  `connection: "reconnecting"` (cause `participant.updated`) under the same grace timer. Inside
  the grace the chair waits for its person: a resume keeps it, and a session of the same account
  joining — the one that left, or a new one — takes the seat over and holds it (§ 8.4). A
  host alone in the room idles it as before.
- A `reconnecting` seat is sent no room broadcasts.
- **Who takes the chair** — one rule for a grace expiry, whether the host's socket dropped
  or the host left:
  the earliest-joined seat of the first of these pools that is not empty: (1) connected seats whose
  `playerState` is `playing`, `paused` or `buffering`; (2) connected seats that are `ready`;
  (3) connected seats; (4) every remaining seat.
- A room whose last participant is removed goes idle rather than closing: it is frozen and
  held for `EMPTY_ROOM_TTL_MS` (§ 8), then removed with `room.closed {reason:"empty"}` — a
  broadcast that by definition reaches nobody. Rejoining within the window revives it.

### 13.4 Removing a seat stuck buffering (`room.removed`)

A seat that cannot get unstuck is given a minute and then taken out of the party, with the reason,
under **either** buffering policy. Under `pause-all` everybody waits out that minute and the removal
ends the wait; under `ignore` the room plays on and only the stuck seat keeps trying.

- **The stall clock.** The server runs one per seat while all of these hold: the seat is
  `connected`; its last recorded `playerState` is `buffering` (from `client.buffering` or a
  `client.position`); the room's `playback.state` is `playing` or `waiting`; and at least one
  **other** seat is `connected`. It is read from the recorded state, not only from edges, so a seat
  that reported `buffering` in the lobby is timed from the moment Start runs the timeline.
- **It measures continuous stall.** Repeated `buffering` reports do not restart it. Anything that
  ends one of the conditions stops and resets it: a report of any other `playerState` or
  `buffering: false`, a `playback.pause`, a `playback.setItem`, the seat disconnecting (the
  reconnect grace of § 13.3 owns that case), the seat leaving, the room closing, or the seat's
  being the only one left connected. The next stall starts a fresh minute.
- **At the limit** — `STALLED_SEAT_REMOVE_MS` on the reference relay, 60 000 ms by default, 0 to
  turn the removal off — the server:
  1. sends that seat `room.removed {reason: "stalled"}`, while it is still a member;
  2. removes the seat exactly as a `room.leave` would, broadcasting `room.state` with cause
     `participant.left` — or `host.changed` when it held the chair, which passes on by the rule of
     § 13.3 — and `cause.reason: "stalled"`. A `pause-all` hold only it kept resumes in that same
     snapshot (§ 13.1).
- **The removed client** leaves the room's screens and tells its person why — for `stalled`, a bad
  connection. It MUST NOT rejoin that room automatically (a resume or relaunch path that walks back
  into its last room included); the person may join it again by hand, and nothing on the server
  refuses that. Every other client names the departure with its reason.
- **Reasons are open strings** (1–64 characters). `stalled` is the only one sent today; a reader
  that does not know a reason still knows the seat was removed. A client without the
  `room.removed` capability (§ 3.1) ignores the message and is removed server-side all the same.
- **With `bufferingMaxWaitMs`.** The two settings are independent. A cap below the removal delay
  lets a `pause-all` room play on at the cap, and the stuck seat is still removed at the delay; a
  cap above it never fires, because the removal ends the wait first.
- **Not a host kick.** The removal is the server's, never a participant's; there is no
  client-to-server message that causes it. Whether a host may remove somebody is the host-kick
  question, still open.

## 14. Error codes

| Code                           | Meaning                                                                                                                                                                                                                           | Retryable |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `UNSUPPORTED_PROTOCOL_VERSION` | Reserved legacy value from pre-capability implementations; current servers never emit it.                                                                                                                                         | no        |
| `INVALID_MESSAGE`              | Malformed JSON or schema violation.                                                                                                                                                                                               | no        |
| `NOT_AUTHENTICATED`            | Message before successful `session.hello`.                                                                                                                                                                                        | no        |
| `AUTH_FAILED`                  | Jellyfin rejects the presented token (`401`/`403`).                                                                                                                                                                               | no        |
| `AUTH_UNAVAILABLE`             | Jellyfin token validation is temporarily unavailable (network/`5xx`).                                                                                                                                                             | yes       |
| `AUTH_EXPIRED`                 | A live session's token is no longer valid or resolves to another user.                                                                                                                                                            | no        |
| `SESSION_RESUME_FAILED`        | Resume token/user mismatch or grace elapsed.                                                                                                                                                                                      | no        |
| `ALREADY_IN_ROOM`              | Session already participates in a room.                                                                                                                                                                                           | no        |
| `JOINED_ON_ANOTHER_DEVICE`     | This Jellyfin account is already in that room from another device with a live socket.                                                                                                                                             | no        |
| `NOT_IN_ROOM`                  | Room-scoped command without membership.                                                                                                                                                                                           | no        |
| `ROOM_NOT_FOUND`               | Unknown or expired roomId.                                                                                                                                                                                                        | no        |
| `ROOM_FULL`                    | Participant limit reached.                                                                                                                                                                                                        | no        |
| `FORBIDDEN`                    | Sender lacks permission (control mode, host-only op), or the maturity rule of § 8.1 refuses a join or an add.                                                                                                                     | no        |
| `VISIBILITY_PENDING`           | The § 8.1 maturity rule has not been resolved yet: the server has not finished determining whether an account may see the media, and refuses the join or the add until it has. Never `FORBIDDEN`, which asserts a settled answer. | yes       |
| `INVALID_STATE`                | Command invalid in the current state (e.g. play with no item).                                                                                                                                                                    | no        |
| `RATE_LIMITED`                 | Token bucket exceeded — per session, or per account for room creation and queue changes (§ 6.4) — or a room cap reached (`MAX_ROOMS`, `MAX_ROOMS_PER_USER`).                                                                      | yes       |
| `INTERNAL`                     | Unexpected server failure.                                                                                                                                                                                                        | yes       |

## 15. WebSocket close codes

| Code | Name             | When                                                                                                                                                                                                                                                                                    |
| ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4000 | PROTOCOL_ERROR   | Oversized/binary frames or repeated invalid traffic — but also capacity limits, hello rate limiting, and retryable authentication unavailability. A preceding `error` frame always carries the real reason; clients MUST branch on its `code`/`retryable`, not on the close code alone. |
| 4001 | AUTH_FAILED      | Jellyfin rejected the token presented during `session.hello`.                                                                                                                                                                                                                           |
| 4002 | AUTH_EXPIRED     | Periodic revalidation found an invalid token or a different user.                                                                                                                                                                                                                       |
| 4003 | HELLO_TIMEOUT    | No `session.hello` within the server's hello window (`HELLO_TIMEOUT_MS`, default 10 s), or superseded before sending one by a newer connection from a full pending pool (§ 7). Reconnect and send the hello at once.                                                                    |
| 4004 | SESSION_REPLACED | Session resumed from a newer socket.                                                                                                                                                                                                                                                    |
| 4005 | SERVER_SHUTDOWN  | Graceful shutdown (clients should reconnect + resume).                                                                                                                                                                                                                                  |
| 4006 | FORBIDDEN_ORIGIN | Browser `Origin` present and not in the allow-list. See the guarantee below — an **absent** `Origin` is never a rejection reason.                                                                                                                                                       |

### 15.1 The no-`Origin` guarantee

`Origin` is a browser concept. `URLSessionWebSocketTask` (Swift, iOS/tvOS) and OkHttp (Kotlin,
Android TV) send no `Origin` header on a WebSocket upgrade, because a native application has no
origin to report.

Servers therefore **MUST** apply the allow-list only to requests that carry an `Origin`, and MUST
accept an upgrade with no `Origin` regardless of how `ALLOWED_ORIGINS` is configured. This is a
normative guarantee, not an implementation detail: every native client depends on it, and a server
that rejected the absence of the header would disconnect all of them simultaneously and
permanently, with no client-side change able to recover.

The allow-list is a defence against a _browser_ being driven cross-origin by a page the user did
not choose. It is not an authentication mechanism, and it cannot be one — any non-browser client
can set or omit the header freely. Authentication is `session.hello`, and only `session.hello`.

Clients MUST map close code `4006` to a message naming the server operator as the party who can
fix it, and MUST NOT retry the connection: the next attempt would be refused identically.

## 16. Security considerations

- **Jellyfin tokens reach the sync server only in `session.hello`.** They are retained privately
  only for the lifetime of a resumable in-memory session, never persisted or logged, and may be
  sent upstream only to the configured Jellyfin's `/Users/Me`. Cache keys are token digests.
  Administrator API keys MUST NOT be embedded in any client or in the sync server.
- **The sync server makes no outbound request to any client-supplied address.** `JELLYFIN_URL` is
  mandatory operator configuration, syntactically validated at boot, and immutable for the
  authenticator lifetime. Redirects are disabled. The one credential-free request it adds for
  § 2.1 — `GET <JELLYFIN_URL>/System/Info/Public` for the `Id` — goes to that same base, bounded
  and without redirects, and its answer is held in memory only: there is no persisted copy and no
  `JELLYFIN_ID` override, so the relay can never advertise an `Id` the configured URL did not
  give it.
- **The discovery document (§ 2.1) never carries `JELLYFIN_URL`**, any token, or anything a
  client could not learn by connecting. The relay's private key never leaves its data volume
  (`IDENTITY_PATH`, written mode 0600 where the filesystem allows). The short code is printed in
  the boot log only; the relay MUST NOT serve it as a suggestion, on `/healthz` or anywhere else,
  because a code the candidate supplied is the candidate vouching for itself.
- **The branding mark (§ 2.3) is written by a person, never by the relay.** It rides Jellyfin's
  own access control — administrators write `CustomCss`, everyone reads it — so pairing needs no
  Jellyfin API key and the relay makes no write to Jellyfin of any kind. A client reads it
  credential-free, bounded and without redirects, and a mark that does not parse is _no mark_,
  never an error, so nothing a stranger could get into a page is something a client acts on.
- Session count limits MAY key on the Jellyfin-verified user id. Pre-authentication pending-socket
  and hello-attempt limits necessarily key on the effective client address and must use a bounded,
  correctly configured proxy-trust policy. Behind a reverse proxy that policy is the operator's
  `TRUST_PROXY`, naming the proxy; unset, every client arrives from the proxy's address, and the
  reference relay says so once in its log the first time a forwarded header arrives. It also
  limits the damage: a full per-address pending pool closes its oldest idle socket rather than
  refusing new ones (§ 7), and a hello that authenticates gives its attempt back, so only failed
  authentications count against the address.
- The reference relay reports room and session counts on `/healthz` only to a caller on the same
  machine (a loopback peer with no forwarded header); anybody else gets `{"status":"ok"}`.
- A live session's token is revalidated every `TOKEN_REVALIDATE_INTERVAL_MS` (default 5 min), so a
  device Jellyfin has signed out keeps its seat for at most that long.
- Externally reachable client, Jellyfin, and relay endpoints MUST use TLS/HTTPS/WSS. A plaintext
  relay listener is valid only on localhost or an internal network behind TLS termination.
- `resumeToken` comparison MUST be constant-time.
- Browser connections SHOULD be checked against an `Origin` allow-list (close `4006`).
- All room permissions are enforced server-side; the client UI is advisory only.
- The sync server trusts `itemId` values opaquely; it never fetches media. A malicious
  participant can therefore only disrupt a room they were invited into, not access media —
  Jellyfin still enforces its own per-user library permissions when each client requests
  streams.

## 17. Implementation notes for native clients (Swift / Kotlin)

- Everything on the wire is plain JSON + `schemas/*.schema.json` (JSON Schema draft
  2020-12) — usable for codegen or hand-written `Codable`/`kotlinx.serialization` models.
- Discriminate on `type`; model payloads per type. Ignore unknown object fields.
- Decode `capabilities` as an open string list, not an enum; unknown future names are valid.
- Emit envelope version `1`, and do not reject a compatible known message solely because its
  received version is another positive integer.
- All the math a client needs is in § 10 and § 12 (a few lines of arithmetic); `src/clock.ts`
  and `src/timeline.ts` are the reference implementations with unit tests
  (`test/timeline.test.ts`) that double as cross-language test vectors.
- Use a monotonic clock for local scheduling, but wall-clock (epoch ms) for the fields
  defined here.
