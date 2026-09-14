// Realtime API latency probe: same timed microphone track as the GPT-Live preview run, direct WebRTC to OpenAI.
// Env: MODEL (default gpt-realtime), VAD=server|semantic, SILENCE_MS (server_vad), EAGERNESS (semantic_vad), RUN_SECONDS, LABEL
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readApiKey } from '../../../src/live.mjs';
const app = new URL('../../../', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const here = new URL('.', import.meta.url).pathname;
const trackDir = new URL('../', import.meta.url).pathname;
const key = readApiKey();
if (!key) { console.error('no OpenAI key'); process.exit(1); }
const model = process.env.MODEL || 'gpt-realtime';
const vad = process.env.VAD || 'server';
const turnDetection = vad === 'semantic'
  ? { type: 'semantic_vad', eagerness: process.env.EAGERNESS || 'high', create_response: true, interrupt_response: true }
  : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: Number(process.env.SILENCE_MS || 500), create_response: true, interrupt_response: true };
const identity = "I'm Vivek Bot, joining this Google Meet meeting, connected to a Claude Code session named meetingproject, via our in-house RoboMeet software.";
const session = { type: 'realtime', model, instructions: `You are an AI meeting participant. Keep answers short and natural. IDENTITY RULE: whenever anyone asks who you are, what you are, or what you are connected to, say this sentence word for word, then stop: "${identity}" If asked only for the session name, answer: meetingproject.`,
  audio: { input: { turn_detection: turnDetection, transcription: { model: 'gpt-4o-mini-transcribe' } }, output: { voice: 'marin' } } };
const track = JSON.parse(readFileSync(trackDir + 'track.json', 'utf8'));
const runFor = Number(process.env.RUN_SECONDS || track.end + 3) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
let callId = null, callError = null;
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(readFileSync(here + 'realtime-page.html')); }
  if (req.method === 'POST' && req.url === '/call') {
    let sdp = ''; for await (const c of req) sdp += c;
    // Plain (non-file) multipart fields with explicit content types, exactly like the documented curl form:
    //   -F "sdp=<offer.sdp;type=application/sdp" -F 'session={...};type=application/json'
    const boundary = '----robomeet' + Math.random().toString(16).slice(2);
    const part = (name, type, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: ${type}\r\n\r\n${value}\r\n`;
    const body = part('sdp', 'application/sdp', sdp) + part('session', 'application/json', JSON.stringify(session)) + `--${boundary}--\r\n`;
    const r = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
    const text = await r.text();
    if (!r.ok) { callError = `HTTP ${r.status}: ${text.replace(/sk-[\w-]+/g, '[redacted]').slice(0, 300)}`; log('call failed', callError); res.writeHead(502); return res.end(callError); }
    callId = (r.headers.get('location') || '').split('/').pop() || null;
    log('call created', callId);
    res.writeHead(200, { 'Content-Type': 'application/sdp' }); return res.end(text);
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(4399, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', PULSE_SINK: 'robomeet_null' },
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${trackDir}track.wav%noloop`, '--autoplay-policy=no-user-gesture-required', '--window-size=700,400', '--window-position=800,120'] });
const context = await browser.newContext();
await context.addInitScript({ path: trackDir + 'init-hooks.js' });
const page = await context.newPage();
try {
  await page.goto('http://127.0.0.1:4399/', { waitUntil: 'domcontentloaded' });
  await page.click('#start');
  const ok = await page.waitForFunction(() => window.__lat.log.some(e => e.type === 'dc' && (e.ev === 'session.created' || e.ev === 'session.updated' || e.ev === 'error')), undefined, { timeout: 30000 }).then(() => true).catch(() => false);
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  log('session:', ok, status);
  const gum = await page.evaluate(() => window.__lat.log.find(e => e.type === 'gum.resolved')?.t);
  const now = await page.evaluate(() => performance.now());
  await page.waitForTimeout(Math.max(0, runFor - (now - gum)));
  const lat = await page.evaluate(() => ({ log: window.__lat.log, stats: window.__lat.stats }));
  await page.evaluate(() => window.__pc?.close());
  const file = `${here}run-realtime-${process.env.LABEL || vad}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ model, turnDetection, track, page: lat, callId, callError }));
  log('wrote', file, 'entries', lat.log.length);
} finally {
  if (callId) await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/hangup`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } }).then(r => log('hangup', r.status)).catch(() => {});
  await browser.close(); server.close();
}
