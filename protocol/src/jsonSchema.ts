import { z } from 'zod';
import { ClientMessageSchema } from './clientMessages';
import { RelayBindingSchema, RelayDiscoverySchema } from './discovery';
import { RoomStateSchema } from './room';
import { ServerMessageSchema } from './serverMessages';
import { SyncConfigSchema } from './syncConfig';

const OPTS = {
  target: 'draft-2020-12',
  io: 'input',
  unrepresentable: 'any',
} as const;

const BASE_ID = 'https://screenfin.dev/schemas/v1';

/**
 * Build the language-neutral JSON Schema documents for the wire protocol.
 * The committed files under `schemas/` are generated from this function via
 * `pnpm generate:schemas`; a test asserts they never drift from the Zod source.
 */
export function buildJsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    'client-messages': {
      ...z.toJSONSchema(ClientMessageSchema, OPTS),
      $id: `${BASE_ID}/client-messages.json`,
      title: 'Screenfin Sync Protocol v1 — client → server messages',
    },
    'server-messages': {
      ...z.toJSONSchema(ServerMessageSchema, OPTS),
      $id: `${BASE_ID}/server-messages.json`,
      title: 'Screenfin Sync Protocol v1 — server → client messages',
    },
    'room-state': {
      ...z.toJSONSchema(RoomStateSchema, OPTS),
      $id: `${BASE_ID}/room-state.json`,
      title: 'Screenfin Sync Protocol v1 — room state',
    },
    'sync-config': {
      ...z.toJSONSchema(SyncConfigSchema, OPTS),
      $id: `${BASE_ID}/sync-config.json`,
      title: 'Screenfin Sync Protocol v1 — synchronization tuning',
    },
    'relay-discovery': {
      ...z.toJSONSchema(RelayDiscoverySchema, OPTS),
      $id: `${BASE_ID}/relay-discovery.json`,
      title: 'Screenfin Sync Protocol v1 — signed relay discovery document (GET /v1/discovery)',
    },
    'relay-binding': {
      ...z.toJSONSchema(RelayBindingSchema, OPTS),
      $id: `${BASE_ID}/relay-binding.json`,
      title: 'Screenfin Sync Protocol v1 — relay binding document (the branding mark, § 2.3)',
    },
  };
}
