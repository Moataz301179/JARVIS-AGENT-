import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = 18991;
const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-test-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, JARVIS_OPERATOR_TOKEN: 'test-token', CHECK_INTERVAL_MS: '999999' },
  stdio: 'ignore'
});
async function request(path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { status: response.status, body: await response.json() };
}
test.before(async () => { for (let i = 0; i < 30; i += 1) { try { if ((await request('/__health')).status === 200) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Server did not start'); });
test.after(async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); });
test('unconfigured dependencies remain unknown', async () => {
  const result = await request('/api/overview');
  assert.equal(result.status, 200); assert.equal(result.body.status, 'unknown'); assert.equal(result.body.dependencies[0].status, 'unknown');
});
test('state-changing operations require an operator token', async () => {
  const denied = await request('/api/checks/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dependencyId: 'runtime' }) });
  assert.equal(denied.status, 403);
  const accepted = await request('/api/checks/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-operator-token': 'test-token' }, body: JSON.stringify({ dependencyId: 'runtime' }) });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.dependency.status, 'unknown');
});
