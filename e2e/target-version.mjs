import { readFileSync } from 'node:fs';

export const defaultExpectedVersion = JSON.parse(
  readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
).version;
export const expectedVersion = process.env.BD_EXPECTED_VERSION || defaultExpectedVersion;
