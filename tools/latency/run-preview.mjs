// Drive a preview-mode GPT Live session with the test track as the microphone and record the full timeline.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const app = new URL('../../', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const here = new URL('.', import.meta.url).pathname;
const base = 'http://127.0.0.1:4318';
const token = readFileSync(app + 'data/control-token', 'utf8').trim();
const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const trackName = process.env.TRACK || 'track';
const track = JSON.parse(readFileSync(here + trackName + '.json', 'utf8'));
const runFor = Number(process.env.RUN_SECONDS || track.end + 3) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const before = await api('/api/state');
if (before.voice.desired === 'started' || before.voice.status !== 'idle') { console.error('voice is not idle:', before.voice); process.exit(1); }
const cursor0 = before.cursor;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', PULSE_SINK: 'robomeet_null' },
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${here}${trackName}.wav%noloop`, '--autoplay-policy=no-user-gesture-required', '--window-size=900,700', '--window-position=700,100'] });
const context = await browser.newContext();
await context.addInitScript({ path: here + 'init-hooks.js' });
const page = await context.newPage();
page.on('console', m => { if (/error|fail/i.test(m.text())) log('console:', m.text().slice(0, 160)); });
const t0 = Date.now();
try {
  await page.goto(`${base}/?preview=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#start-voice:not([disabled])', { timeout: 15000 });
  const startWall = Date.now();
  await page.click('#start-voice');
  log('clicked start voice');
  const started = await page.waitForFunction(() => window.__lat.log.some(e => e.type === 'dc' && e.ev === 'session.started'), undefined, { timeout: 40000 }).then(() => true).catch(() => false);
  log('session.started seen:', started);
  if (process.env.ANNOUNCE) {
    await page.waitForTimeout(1500);
    const tAnn = await page.evaluate(() => performance.now());
    const res = await api('/api/command', { type: 'announce', text: process.env.ANNOUNCE });
    await page.evaluate(t => window.__lat.log.push({ t, type: 'announce.sent' }), tAnn);
    log('announce sent', res.error ? res.error : 'ok');
  }
  const gum = await page.evaluate(() => window.__lat.log.find(e => e.type === 'gum.resolved')?.t);
  const nowPage = await page.evaluate(() => performance.now());
  const remaining = Math.max(0, runFor - (nowPage - gum));
  log(`mic started; waiting ${Math.round(remaining / 1000)} s for the track to finish`);
  await page.waitForTimeout(remaining);
  await page.click('#stop-voice');
  log('clicked stop voice');
  await page.waitForFunction(() => document.getElementById('voice-status').textContent === 'Voice is off', undefined, { timeout: 30000 }).catch(() => log('stop not confirmed in page'));
  const lat = await page.evaluate(() => ({ log: window.__lat.log, stats: window.__lat.stats, now: performance.now(), wall: Date.now() }));
  const after = await api('/api/state');
  const events = (after.events || []).filter(e => e.cursor === undefined || true).slice(-400);
  const out = { startedAtWall: startWall, track, page: lat, server: { voice: after.voice, events: events.filter(e => Date.parse(e.at) >= t0 - 1000) } };
  const file = `${here}run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(out));
  log('wrote', file, 'log entries', lat.log.length, 'stats', lat.stats.length, 'usage seconds', after.voice?.usage?.seconds ?? '?');
} finally {
  await api('/api/command', { type: 'voice-stop' }).catch(() => {});
  await browser.close();
}
