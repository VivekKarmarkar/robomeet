// End-to-end in-meeting measurement without a human: launch the robot (attend.mjs) into a meeting, then join the same
// meeting as a second participant whose microphone is the timed test track, and record what that participant hears.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const app = new URL('../../', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const here = new URL('.', import.meta.url).pathname;
const meetUrl = process.env.MEET_URL || 'https://meet.google.com/onh-rhid-zuu';
const profile = process.env.OBSERVER_PROFILE || app + 'data/observer-profile';
const attendArgs = (process.env.ATTEND_ARGS || '--no-share').split(' ').filter(Boolean);
const base = 'http://127.0.0.1:4318';
import { existsSync, cpSync, rmSync } from 'node:fs';
if (!existsSync(profile)) {
  console.log('copying the robot profile to', profile, '(observer joins as the same account on a second device)');
  cpSync(app + 'data/browser-profile', profile, { recursive: true });
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(profile + '/' + lock, { force: true });
}
const token = readFileSync(app + 'data/control-token', 'utf8').trim();
const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const track = JSON.parse(readFileSync(here + 'observer-track.json', 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const wallStart = Date.now();
const attendLines = [];
// 1) robot side
const attend = spawn('node', ['bin/attend.mjs', meetUrl, '--agent', 'Claude Code', '--cwd', app, '--project', 'robomeet', '--session-name', 'meetingproject', '--json', ...attendArgs], { cwd: app, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
attend.stdout.on('data', d => { for (const line of d.toString().split('\n').filter(Boolean)) { attendLines.push(line); try { const j = JSON.parse(line); log('attend:', j.event, j.status || j.trigger || j.url || ''); } catch { log('attend:', line.slice(0, 120)); } } });
attend.stderr.on('data', d => log('attend!', d.toString().trim().slice(0, 200)));
const joined = await new Promise(resolve => { const t = setTimeout(() => resolve(false), 150000); attend.stdout.on('data', d => { if (d.toString().includes('"event":"joined"')) { clearTimeout(t); resolve(true); } }); attend.on('exit', () => { clearTimeout(t); resolve(false); }); });
if (!joined) { log('robot did not join'); attend.kill('SIGTERM'); process.exit(1); }
log('robot joined; launching observer');
// 2) observer side
const context = await chromium.launchPersistentContext(profile, { executablePath: '/usr/bin/google-chrome', headless: false, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', PULSE_SINK: 'robomeet_null' },
  ignoreDefaultArgs: ['--enable-automation', '--password-store=basic', '--use-mock-keychain'], permissions: ['microphone', 'camera'], viewport: { width: 1100, height: 750 },
  args: ['--disable-blink-features=AutomationControlled', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${here}observer-track.wav%noloop`, '--autoplay-policy=no-user-gesture-required', '--window-size=1100,750', '--window-position=60,40'] });
await context.addInitScript({ path: here + 'observer-hooks.js' });
const page = await context.newPage();
const shot = name => page.screenshot({ path: `${here}obs-${name}.png` }).catch(() => {});
const events = [];
const mark = (type, extra = {}) => events.push({ wall: Date.now(), type, ...extra });
let obs = { log: [], wall0: 0, perf0: 0 };
const pull = async () => { try { obs = await page.evaluate(() => window.__obs); } catch {} };
try {
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Meet shows "Switch here" for a second device of the same account, with a "Got it" callout covering the rest.
  const callout = page.getByRole('button', { name: /^Got it$/i }).first();
  await callout.waitFor({ state: 'visible', timeout: 4000 }).then(() => callout.click()).catch(() => {});
  await page.waitForTimeout(800);
  await shot('prejoin');
  const labels = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], a, span')].filter(b => b.getClientRects().length).map(b => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 40)).then(list => [...new Set(list)].slice(0, 80));
  log('prejoin controls:', JSON.stringify(labels));
  let joinButton = page.getByRole('button', { name: /^(Join here too|Join now|Join anyway|Ask to join)$/i }).first();
  if (!(await joinButton.isVisible().catch(() => false))) {
    // Second device of the same account: "Join here too" lives under "Other ways to join".
    const other = page.getByText(/^Other ways to join$/i).first();
    if (await other.isVisible().catch(() => false)) { await other.click(); await page.waitForTimeout(800); await shot('other-ways'); }
    const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button, span')].filter(b => b.getClientRects().length).map(b => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 60)).then(list => [...new Set(list)].slice(-40));
    log('menu controls:', JSON.stringify(menu));
    joinButton = page.getByRole('menuitem', { name: /Join here too/i }).first();
    if (!(await joinButton.isVisible().catch(() => false))) joinButton = page.getByText(/Join here too/i).first();
  }
  await joinButton.waitFor({ state: 'visible', timeout: 15000 });
  const label = await joinButton.innerText().catch(() => '');
  await joinButton.click(); mark('join.click', { label: label.trim() });
  log('clicked', label.trim());
  const leave = page.getByRole('button', { name: /^(Leave call|Leave meeting)/i }).first();
  await leave.waitFor({ state: 'visible', timeout: 60000 }); mark('admitted');
  log('observer admitted');
  await shot('incall');
  // make sure the observer's microphone is on (Meet may mute a second device of the same account)
  const micOn = page.getByRole('button', { name: /^Turn on microphone/i }).first();
  if (await micOn.isVisible().catch(() => false)) { await micOn.click(); mark('mic.unmuted'); log('unmuted observer mic'); }
  const gotIt = page.getByRole('button', { name: /^Got it$/i }).first();
  const deadline = Date.now() + (track.end + 6) * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000); await pull();
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click().catch(() => {});
  }
  await shot('end');
} catch (error) { log('observer error:', error.message.split('\n')[0]); await shot('error'); }
await pull();
const state = await api('/api/state');
// Leave properly so Meet drops this device at once (a ghost participant of the same account blocks the robot's next join).
try { const leaveButton = page.getByRole('button', { name: /^(Leave call|Leave meeting)/i }).first(); if (await leaveButton.isVisible().catch(() => false)) { await leaveButton.click(); mark('observer.left'); await page.waitForTimeout(2500); } } catch {}
await context.close().catch(() => {});
// 3) stop the robot and collect
attend.kill('SIGTERM');
await new Promise(resolve => { attend.on('exit', resolve); setTimeout(resolve, 20000); });
const after = await api('/api/state');
const out = { wallStart, meetUrl, track, observer: { events, page: obs }, attend: attendLines, server: { events: (after.events || []).filter(e => Date.parse(e.at) >= wallStart - 1000), voice: state.voice, meeting: state.meeting } };
const file = `${here}obs-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(out)); log('wrote', file);
