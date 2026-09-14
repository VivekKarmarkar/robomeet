#!/usr/bin/env node
// RoboMeet attend-stop — pull the robot out of the meeting: stop voice if it is running, leave the meeting,
// unmute the laptop speakers, and print the final meeting and voice status. Pass --json for a JSON line.
// Self-contained; shares only the HTTP contract with bin/attend.mjs (GET /api/state, POST /api/command, bearer token).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const dataDir = process.env.ROBO_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url));
const base = new URL(process.env.ROBO_URL || 'http://127.0.0.1:4318');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('RoboMeet commands must target the local app.');
const json = process.argv.includes('--json');
const isDown = error => error.code === 'ENOENT' || error.name === 'TimeoutError' || ['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code);

async function api(path, body) {
  const token = (await readFile(join(dataDir, 'control-token'), 'utf8')).trim();
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body ? 55000 : 10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || `HTTP ${response.status}`);
  return result;
}
const command = body => api('/api/command', body);

async function unmute() {
  try { await promisify(execFile)('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']); return 'unmuted'; }
  catch (error) { return `unmute failed: ${String(error.message).split('\n')[0]}`; }
}

const steps = [];
let snapshot = null;
try {
  snapshot = await api('/api/state');
  const voice = snapshot.voice || {};
  if (voice.desired === 'started' || ['connecting', 'active', 'closing'].includes(voice.status)) {
    await command({ type: 'voice-stop' }).then(() => steps.push('voice stopped')).catch(error => steps.push(`voice-stop failed: ${error.message}`));
  } else steps.push('voice already idle');
  await command({ type: 'leave' }).then(() => steps.push('left meeting')).catch(error => steps.push(`leave failed: ${error.message}`));
  snapshot = await api('/api/state').catch(() => snapshot);
} catch (error) {
  if (!isDown(error)) { process.stderr.write(`RoboMeet: ${error.message}\n`); process.exitCode = 1; }
  else steps.push('server not running: nothing to stop');
}
steps.push(`laptop ${await unmute()}`);

const meeting = snapshot?.meeting || {}, voice = snapshot?.voice || {};
const status = { meeting: meeting.status || 'unknown', voice: voice.status || 'unknown', voiceDesired: voice.desired || 'unknown', voiceSeconds: voice.usage?.seconds ?? null, url: meeting.url || null };
if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event: 'stopped', steps, ...status }));
else console.log(`RoboMeet stop: ${steps.join('; ')}. Final status: meeting=${status.meeting} voice=${status.voice} (desired ${status.voiceDesired})${status.voiceSeconds !== null ? ` voiceSeconds=${status.voiceSeconds}` : ''}${status.url ? ` url=${status.url}` : ''}`);
