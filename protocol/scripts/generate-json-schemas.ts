import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemas } from '../src/jsonSchema';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(outDir, { recursive: true });

const schemas = buildJsonSchemas();
for (const [name, schema] of Object.entries(schemas)) {
  const file = join(outDir, `${name}.schema.json`);
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
