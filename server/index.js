import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = Number(process.env.PORT || 8080);
const dataDir = process.env.DATA_DIR || join(root, 'data');
const statePath = join(dataDir, 'state.json');
const pollEveryMs = Math.max(15_000, Number(process.env.CHECK_INTERVAL_MS || 60_000));
const now = () => new Date().toISOString();

function configuredDependencies() {
  try {
    const value = JSON.parse(process.env.JARVIS_DEPENDENCIES_JSON || '[]');
    if (!Array.isArray(value)) throw new Error('must be an array');
    return value.filter(item => item?.id && item?.name).map(item => ({
      id: String(item.id), name: String(item.name), kind: String(item.kind || 'service'),
      healthUrl: item.healthUrl ? String(item.healthUrl) : null,
      owner: item.owner ? String(item.owner) : null
    }));
  } catch {
    return [];
  }
}

const defaults = [
  { id: 'runtime', name: 'Remote runtime', kind: 'runtime', healthUrl: null },
  { id: 'deployment', name: 'Deployment pipeline', kind: 'deployment', healthUrl: null },
  { id: 'scheduler', name: 'Scheduled task runner', kind: 'scheduler', healthUrl: null },
  { id: 'notifications', name: 'Notification delivery', kind: 'notification', healthUrl: null }
];

let state;
async function loadState() {
  await mkdir(dataDir, { recursive: true });
  if (existsSync(statePath)) {
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = null; }
  }
  if (!state) {
    state = { version: 1, createdAt: now(), dependencies: [], checks: [], tasks: [], notifications: [], recoveryActions: [] };
  }
  const configured = configuredDependencies();
  const input = configured.length ? configured : defaults;
  const old = new Map((state.dependencies || []).map(item => [item.id, item]));
  state.dependencies = input.map(item => ({ ...item, ...old.get(item.id), healthUrl: item.healthUrl, status: old.get(item.id)?.status || 'unknown' }));
  await save();
}
async function save() {
  const temp = `${statePath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, statePath);
}
function record(collection, value) {
  const item = { id: randomUUID(), at: now(), ...value };
  state[collection].unshift(item);
  state[collection] = state[collection].slice(0, 250);
  return item;
}
function dependency(id) { return state.dependencies.find(item => item.id === id); }
async function check(dep, trigger = 'manual') {
  const task = record('tasks', { type: 'dependency_check', dependencyId: dep.id, trigger, status: 'running', startedAt: now() });
  if (!dep.healthUrl) {
    dep.status = 'unknown'; dep.lastCheckedAt = now(); dep.evidence = 'No configured, read-only health endpoint.';
    task.status = 'unknown'; task.finishedAt = now(); task.message = dep.evidence;
    record('checks', { dependencyId: dep.id, status: 'unknown', trigger, message: dep.evidence });
    await save(); return dep;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(dep.healthUrl, { signal: controller.signal, headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.1' } });
    dep.status = response.ok ? 'confirmed' : 'failed';
    dep.lastCheckedAt = now(); dep.lastHttpStatus = response.status;
    dep.evidence = response.ok ? `Health endpoint responded HTTP ${response.status}.` : `Health endpoint responded HTTP ${response.status}.`;
    task.status = dep.status; task.finishedAt = now(); task.message = dep.evidence;
    record('checks', { dependencyId: dep.id, status: dep.status, trigger, httpStatus: response.status, message: dep.evidence });
  } catch (error) {
    dep.status = 'failed'; dep.lastCheckedAt = now(); dep.evidence = `Health check failed: ${error.name === 'AbortError' ? 'timed out after 8 seconds' : error.message}`;
    task.status = 'failed'; task.finishedAt = now(); task.message = dep.evidence;
    record('checks', { dependencyId: dep.id, status: 'failed', trigger, message: dep.evidence });
  } finally { clearTimeout(timer); await save(); }
  return dep;
}
async function runAll(trigger = 'scheduler') {
  for (const dep of state.dependencies) await check(dep, trigger);
}
function summary() {
  const totals = { confirmed: 0, unknown: 0, failed: 0 };
  for (const dep of state.dependencies) totals[dep.status] = (totals[dep.status] || 0) + 1;
  return { status: totals.failed ? 'failed' : totals.confirmed === state.dependencies.length ? 'confirmed' : 'unknown', totals };
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function requestBody(request) {
  let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 32_000) throw new Error('Request too large'); }
  return body ? JSON.parse(body) : {};
}
function safeCommand(command) {
  return /^systemctl restart [a-zA-Z0-9@_.-]+$/.test(command || '');
}
function operatorAuthorized(request) {
  const expected = process.env.JARVIS_OPERATOR_TOKEN;
  const supplied = request.headers['x-jarvis-operator-token'];
  if (!expected) return { ok: false, status: 503, error: 'Operator token is not configured on this service.' };
  if (!supplied || Buffer.byteLength(expected) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return { ok: false, status: 403, error: 'A valid operator token is required for this action.' };
  return { ok: true };
}
async function sendNotification(kind = 'test') {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return record('notifications', { kind, status: 'unknown', message: 'No notification provider endpoint configured.' });
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: `jarvis.${kind}`, reference: randomUUID(), sentAt: now() }) });
    return record('notifications', { kind, status: response.ok ? 'accepted' : 'failed', httpStatus: response.status, message: response.ok ? 'Provider accepted request; delivery remains unconfirmed until a receipt is recorded.' : `Provider rejected request (HTTP ${response.status}).` });
  } catch (error) { return record('notifications', { kind, status: 'failed', message: `Notification request failed: ${error.message}` }); }
}
async function serveFile(response, pathname) {
  const allowed = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!['index.html', 'script.js', 'style.css'].includes(allowed)) return false;
  const path = normalize(join(root, allowed));
  const type = allowed.endsWith('.html') ? 'text/html; charset=utf-8' : allowed.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(await readFile(path)); return true;
}

await loadState();
setInterval(() => runAll('scheduler').catch(() => undefined), pollEveryMs).unref();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/__health') return json(response, 200, { status: 'ok', service: 'jarvis-control-plane', time: now() });
    if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, { ...summary(), dependencies: state.dependencies, checks: state.checks.slice(0, 20), tasks: state.tasks.slice(0, 20), notifications: state.notifications.slice(0, 20), recoveryActions: state.recoveryActions.slice(0, 20), generatedAt: now() });
    if (request.method === 'POST') { const auth = operatorAuthorized(request); if (!auth.ok) return json(response, auth.status, { error: auth.error }); }
    if (request.method === 'POST' && url.pathname === '/api/checks/run') { const body = await requestBody(request); const dep = dependency(body.dependencyId); return dep ? json(response, 200, { dependency: await check(dep) }) : json(response, 404, { error: 'Dependency not found' }); }
    if (request.method === 'POST' && url.pathname === '/api/checks/run-all') { await runAll('manual'); return json(response, 200, { ...summary(), dependencies: state.dependencies }); }
    if (request.method === 'POST' && url.pathname === '/api/notifications/test') { const notification = await sendNotification('test'); await save(); return json(response, 200, { notification }); }
    if (request.method === 'POST' && url.pathname === '/api/notifications/receipt') { const body = await requestBody(request); if (!body.receiptId || !body.provider) return json(response, 400, { error: 'provider and receiptId are required' }); const receipt = record('notifications', { kind: 'receipt', status: 'confirmed', provider: String(body.provider), receiptId: String(body.receiptId), message: 'Provider delivery receipt recorded.' }); await save(); return json(response, 201, { receipt }); }
    if (request.method === 'POST' && url.pathname === '/api/recovery/request') { const body = await requestBody(request); const action = record('recoveryActions', { dependencyId: body.dependencyId || null, type: body.type || 'investigate', status: 'pending_approval', requestedBy: body.requestedBy || 'operator', rationale: body.rationale || 'No rationale supplied', rollbackPlan: body.rollbackPlan || 'Not supplied' }); await save(); return json(response, 201, { action }); }
    if (request.method === 'POST' && /^\/api\/recovery\/[^/]+\/approve$/.test(url.pathname)) { const id = url.pathname.split('/')[3]; const action = state.recoveryActions.find(item => item.id === id); if (!action) return json(response, 404, { error: 'Recovery action not found' }); if (process.env.ALLOW_RECOVERY_ACTIONS !== 'true' || !safeCommand(process.env.SERVICE_RESTART_COMMAND)) { action.status = 'approval_recorded_execution_disabled'; action.approvedAt = now(); action.evidence = 'Approval recorded; server execution remains disabled by configuration.'; await save(); return json(response, 200, { action }); }
      action.status = 'running'; action.approvedAt = now(); await save(); const [bin, ...args] = process.env.SERVICE_RESTART_COMMAND.split(' '); const child = spawn(bin, args, { stdio: 'ignore' }); child.once('exit', async code => { action.status = code === 0 ? 'completed' : 'failed'; action.finishedAt = now(); action.evidence = `Command exited with code ${code}`; await save(); }); return json(response, 202, { action }); }
    if (request.method === 'GET' && await serveFile(response, url.pathname)) return;
    json(response, 404, { error: 'Not found' });
  } catch (error) { json(response, 400, { error: error.message || 'Request failed' }); }
});
server.listen(port, () => console.log(`Jarvis control plane listening on :${port}`));
