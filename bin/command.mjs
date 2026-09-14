#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const [action = 'status', ...args] = process.argv.slice(2);
const base = new URL(process.env.ROBO_URL || 'http://127.0.0.1:4318');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('RoboMeet commands must target the local app.');
let path = '/api/command';
let body;
switch (action) {
  case 'status': path = '/api/state'; break;
  case 'listen': path = `/api/listen?after=${Number(args[0] || 0)}&timeout=${Number(args[1] || 50000)}`; break;
  case 'join': body = { type: 'join', url: args[0] }; break;
  case 'leave': body = { type: 'leave' }; break;
  case 'start-voice': body = { type: 'voice-start' }; break;
  case 'stop-voice': body = { type: 'voice-stop' }; break;
  case 'mode': body = { type: 'mode', mode: args[0] }; break;
  case 'context': body = { type: 'context', text: args.join(' ') }; break;
  case 'note': body = { type: 'note', text: args.join(' ') }; break;
  case 'reply': body = { type: 'reply', jobId: args[0], result: args.slice(1).join(' ') }; break;
  case 'present': {
    if (!args[0]) throw new Error('Usage: node bin/command.mjs present slides.json');
    const deck = JSON.parse(await readFile(args[0], 'utf8'));
    body = { type: 'present', ...(Array.isArray(deck) ? { slides: deck } : deck) };
    break;
  }
  case 'share': body = { type: 'share', enabled: args[0] !== 'off' }; break;
  default: throw new Error('Commands: status, join URL, leave, start-voice, stop-voice, mode quiet|listen|speak, context TEXT, note TEXT, reply JOB_ID TEXT, present FILE.json, share on|off');
}
try {
  const directory = process.env.ROBO_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url));
  const token = (await readFile(join(directory, 'control-token'), 'utf8')).trim();
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(55000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || `HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`RoboMeet: ${error.message}. ${error.cause?.code === 'ECONNREFUSED' ? 'Start the app with npm start first.' : ''}\n`);
  process.exitCode = 1;
}
