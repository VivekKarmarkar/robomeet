// Test helper: waits for the first coding-agent job, holds it for HOLD_MS (default 25 s) like a slow coding agent, then replies.
import { readFileSync } from 'node:fs';
const app = new URL('../../', import.meta.url).pathname;
const token = readFileSync(app + 'data/control-token', 'utf8').trim();
const base = 'http://127.0.0.1:4318';
const hold = Number(process.env.HOLD_MS || 25000);
const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), 'replier:', ...a);
let cursor = (await api('/api/state')).cursor;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const r = await fetch(`${base}/api/listen?after=${cursor}&timeout=20000&types=agent.request`, { headers: { Authorization: `Bearer ${token}` } }).then(x => x.json());
  cursor = r.cursor ?? cursor;
  const job = (r.jobs || [])[0];
  if (job) {
    log('job received:', job.id, '|', job.request.slice(0, 80));
    await new Promise(x => setTimeout(x, hold));
    await api('/api/command', { type: 'reply', jobId: job.id, result: 'There are twelve files in the project folder, not counting the data directory.' });
    log('replied after', hold / 1000, 's');
    process.exit(0);
  }
}
log('no job arrived'); process.exit(1);
