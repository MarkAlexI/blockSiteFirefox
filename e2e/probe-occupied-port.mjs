import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExtensionHarness } from './fixtures.mjs';
import { allocateLoopbackPorts } from './ports.mjs';

const output = path.resolve(process.env.BD_E2E_RESULTS || 'test-results', 'occupied-port');
await mkdir(output, { recursive: true });
const result = { probe: 'occupied-port setup failure', bodyStarted: false, status: 'not-run' };
const harness = new ExtensionHarness({ headless: true, installation: 'persistent', output }, result);
let held;
try {
  await harness.prepare();
  const ports = await allocateLoopbackPorts(3);
  held = createServer();
  await new Promise(resolve => held.listen(ports[1], '127.0.0.1', resolve));
  await assert.rejects(harness.launch({ ports }), error => {
    result.error = error.message; result.phase = harness.phase;
    return /Firefox setup port .* unavailable: EADDRINUSE/.test(error.message);
  });
  assert.equal(Boolean(harness.driver), false);
  assert.equal(Boolean(harness.service), false);
  assert.equal(result.bodyStarted, false);
  result.status = 'passed'; result.ports = ports; result.browserProcessesStarted = 0;
} finally {
  if (held?.listening) await new Promise(resolve => held.close(resolve));
  await harness.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
