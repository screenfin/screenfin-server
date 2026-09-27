/**
 * The two pieces of Jellyfin HTTP plumbing shared by every request the relay
 * makes — identity validation (`./identity.ts`) and item visibility
 * (`./visibility.ts`).
 *
 * Both go out with the *user's own* token. The security boundary permits exactly
 * these two kinds of Jellyfin request against the fixed, operator-controlled
 * base URL, and the maturity rule records why a service credential was rejected for the
 * second one: an admin API key is a skeleton key to the whole media server,
 * held by a service that is published to the internet.
 */

/**
 * The relay's `Authorization` header for a request made as one user.
 *
 * Only `Token` and `Client`, deliberately. Jellyfin writes a differing
 * `Device` or `Version` back onto the device record the token belongs to
 * (v12.0 `AuthorizationContext.cs:154-178`), so a fixed relay pair would
 * rename the user's own app in their Devices list on every revalidation;
 * `Client` is read but never written back.
 */
export function jellyfinAuthHeader(token: string): string {
  return `MediaBrowser Token="${token}", Client="Screenfin Relay"`;
}

/**
 * Read a JSON response body, refusing one larger than `maxBytes`.
 *
 * The declared `content-length` is checked first because it is free, and the
 * stream is then counted anyway: an upstream that lies about its length, or
 * sends none, must not be able to make the relay buffer without limit.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  what: string,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Jellyfin ${what} response exceeds the size limit`);
  }

  if (response.body === null) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Jellyfin ${what} response exceeds the size limit`);
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
