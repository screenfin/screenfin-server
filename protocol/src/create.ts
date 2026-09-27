import type { ClientMessageOf, ClientMessageType } from './clientMessages';
import type { ServerMessageOf, ServerMessageType } from './serverMessages';
import { PROTOCOL_VERSION } from './version';

/**
 * RFC 4122 v4 UUID that also works in browser INSECURE contexts. `crypto.randomUUID`
 * is gated to secure contexts (https / localhost), so a client served over plain HTTP
 * on a LAN IP would otherwise throw. Falls back to `crypto.getRandomValues` (which IS
 * available in insecure contexts) and finally to `Math.random`.
 */
export function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rnd = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(rnd);
  else for (let i = 0; i < rnd.length; i += 1) rnd[i] = Math.floor(Math.random() * 256);
  const hex: string[] = [];
  rnd.forEach((b, i) => {
    const v = i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b;
    hex.push(v.toString(16).padStart(2, '0'));
  });
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newMessageId(): string {
  return randomUuid();
}

export interface CreateMessageOptions {
  roomId?: string;
  id?: string;
  sentAt?: number;
}

export function createClientMessage<T extends ClientMessageType>(
  type: T,
  payload: ClientMessageOf<T>['payload'],
  opts: CreateMessageOptions = {},
): ClientMessageOf<T> {
  return {
    version: PROTOCOL_VERSION,
    id: opts.id ?? newMessageId(),
    type,
    ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
    sentAt: opts.sentAt ?? Date.now(),
    payload,
  } as ClientMessageOf<T>;
}

export interface CreateServerMessageOptions extends CreateMessageOptions {
  replyTo?: string;
}

export function createServerMessage<T extends ServerMessageType>(
  type: T,
  payload: ServerMessageOf<T>['payload'],
  opts: CreateServerMessageOptions = {},
): ServerMessageOf<T> {
  return {
    version: PROTOCOL_VERSION,
    id: opts.id ?? newMessageId(),
    type,
    ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
    sentAt: opts.sentAt ?? Date.now(),
    payload,
  } as ServerMessageOf<T>;
}
