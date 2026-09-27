import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The headers the web client is served with when this process carries it (`WEB_ROOT`), security
 * review M3. The client keeps the viewer's Jellyfin session in `localStorage`, so the policy's job
 * is to make sure nothing but this origin's own scripts can ever run beside it — and that no other
 * site can frame the page and steer a signed-in host's clicks.
 *
 * **What the policy cannot pin, and why.** The web client asks for its Jellyfin address on the
 * login screen and keeps it per browser, because the address a browser can reach is often not the
 * relay's own `JELLYFIN_URL` (split-horizon DNS, container networking, remote viewers). So `connect-src`, `img-src` and `media-src` allow any `http:`/`https:` origin.
 * That leaves exfiltration open to a script that is already running; what it closes is the script
 * getting to run, which is the part that matters: `script-src` names this origin and the hashes of
 * the bundle's own inline code, and nothing else — no `'unsafe-inline'`, no `'unsafe-eval'`.
 *
 * `style-src` keeps `'unsafe-inline'`: the toast library injects a `<style>` element at runtime and
 * the offline page carries a `<style>` block. Styles cannot read storage.
 *
 * HSTS is the TLS-terminating proxy's to send; this process speaks plain HTTP.
 */
export interface WebSecurityHeaders {
  /** Sent with every HTML response. */
  html: Record<string, string>;
  /** Sent with every response, HTML or not, web client or not. */
  all: Record<string, string>;
}

const ALL_RESPONSES: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const hash = (text: string): string =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The hashes of every inline `<script>` body and every inline event handler in the bundle's
 * top-level HTML files, read once at boot. Only what the build shipped is allowed; a script
 * injected later hashes to something else and is refused.
 *
 * Deliberately a small, literal reading of the markup Vite and the bundle's static pages emit,
 * not a general HTML parser: a construct it does not recognise is simply not allowed, and the
 * cost of that is the browser refusing a script, which the web client's end-to-end check sees.
 */
export function inlineScriptHashes(webRoot: string): { scripts: string[]; handlers: string[] } {
  const scripts = new Set<string>();
  const handlers = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(webRoot).filter((name) => name.endsWith('.html'));
  } catch {
    return { scripts: [], handlers: [] };
  }
  for (const name of files) {
    const html = readFileSync(join(webRoot, name), 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attributes = match[1] ?? '';
      const body = match[2] ?? '';
      if (/\bsrc\s*=/i.test(attributes) || body.trim() === '') continue;
      scripts.add(hash(body));
    }
    for (const match of html.matchAll(/\son[a-z]+\s*=\s*"([^"]*)"/gi)) {
      handlers.add(hash(match[1] ?? ''));
    }
  }
  return { scripts: [...scripts].sort(), handlers: [...handlers].sort() };
}

export function webSecurityHeaders(webRoot: string | null): WebSecurityHeaders {
  if (webRoot === null) return { html: {}, all: ALL_RESPONSES };
  const inline = inlineScriptHashes(webRoot);
  const scriptSrc = [
    "'self'",
    ...inline.scripts,
    // Hashes of inline handlers only count under 'unsafe-hashes', which allows those exact
    // handlers and nothing else.
    ...(inline.handlers.length > 0 ? ["'unsafe-hashes'", ...inline.handlers] : []),
  ];
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "connect-src 'self' http: https: ws: wss:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    html: {
      'content-security-policy': csp,
      // `frame-ancestors` for engines that predate it.
      'x-frame-options': 'DENY',
    },
    all: ALL_RESPONSES,
  };
}
