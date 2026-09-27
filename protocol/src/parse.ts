import type { ZodError, ZodType } from 'zod';
import { type ClientMessage, ClientMessageSchema } from './clientMessages';
import { type ServerMessage, ServerMessageSchema } from './serverMessages';

export type ParseFailure = { ok: false; error: 'invalid-json' | ZodError };
export type ParseResult<T> = { ok: true; message: T } | ParseFailure;

function parseWith<T>(schema: ZodType<T>, raw: unknown): ParseResult<T> {
  let value = raw;
  if (typeof value === 'string' || value instanceof Uint8Array) {
    try {
      const text =
        typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value);
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: 'invalid-json' };
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) return { ok: false, error: result.error };
  return { ok: true, message: result.data };
}

/** Parse and validate an inbound client → server message (server side). */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, raw);
}

/** Parse and validate an inbound server → client message (client side). */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw);
}

/**
 * Best-effort extraction of a message id from an arbitrary (possibly invalid)
 * inbound frame, so protocol errors can still carry a `replyTo`.
 */
export function extractMessageId(raw: unknown): string | undefined {
  let value = raw;
  if (typeof value === 'string' || value instanceof Uint8Array) {
    try {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string' && id.length >= 8 && id.length <= 64) return id;
  }
  return undefined;
}
