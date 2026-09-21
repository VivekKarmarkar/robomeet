// Live presentation measurement without a human (docs/presentation-spec.md TC-R5, L1, L2, X1, X2, X3, S1, S2, L3).
// 1. creates a fresh Meet space on the robot account (or uses MEET_URL), 2. launches the robot with bin/attend.mjs
// (sharing off at join), 3. joins the same meeting as a second device of that account ("Join here too") with a large
// window and tools/present-lab/observer-present-hooks.js, 4. drives the presentation through the local API and
// measures, from the observer's side: time to share, received resolution and content type, a still frame scored
// against the exact view render, per-move latency and fps, share off/on reliability, and (NARRATE=1) narration sync.
// Env: MEET_URL, VOICE=1 (voice on; required for NARRATE), NARRATE=1, INTERRUPT=1 (a question during part 2, then
// "Okay, continue"), NEXT_MID=1 ("presenter next" 3 s into part 1: does the robot stop talking over the moved screen?),
// CYCLES (share off/on cycles, default 5),
// SLUG (deck, default projectile-motion-deck).  Bills GPT Live only with VOICE=1.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { score } from './fixture-score.mjs';

const app = new URL('../../', import.meta.url).pathname;
const here = new URL('.', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const base = 'http://127.0.0.1:4318';
const token = readFileSync(app + 'data/control-token', 'utf8').trim();
const voice = process.env.VOICE === '1';
const narrate = voice && process.env.NARRATE === '1';
const cycles = Number(process.env.CYCLES || 5);
const slug = process.env.SLUG || 'projectile-motion-deck';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(here, 'runs', `live-${stamp}`);
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const lines = [];
const log = (...values) => { const line = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${values.join(' ')}`; lines.push(line); console.log(line); };
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { stamp, voice, narrate, slug, checks: {} };

// ---- meeting
let meetUrl = process.env.MEET_URL;
if (!meetUrl) {
  const created = JSON.parse(execFileSync('gws', ['meet', 'spaces', 'create', '--json', JSON.stringify({ config: { accessType: 'OPEN', entryPointAccess: 'ALL' } })], { cwd: app, env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(app, 'data/gws-meet-auth') }, encoding: 'utf8' }));
  meetUrl = created.meetingUri;
}
results.meetUrl = meetUrl;
log('meeting', meetUrl);

// ---- robot
const attendArgs = ['bin/attend.mjs', meetUrl, '--agent', 'Claude Code', '--cwd', app, '--project', 'robomeet', '--session-name', 'meetingproject', '--json', '--no-greet',
  '--purpose', 'Self-test of the RoboMeet presentation stage by the Claude Code session; no human is in this meeting, only a second device of the robot account that measures what it receives.',
  '--brief', (process.env.INTERRUPT === '1' || process.env.DELEGATE === '1' || process.env.POINT === '1' ? 'This is an automated test. A second participant (a test voice) may ask you questions and ask you to hand requests to the coding agent or to point at things on your screen; treat it like a person. Present the deck you are given when cued.' : 'Present the deck you are given when cued. Nobody will speak to you in this test.'), ...(voice ? ['--voice-on', 'join'] : ['--no-voice-auto'])];
const attend = spawn('node', attendArgs, { cwd: app, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const attendLog = [];
attend.stdout.on('data', data => { for (const line of data.toString().split('\n').filter(Boolean)) { attendLog.push(line); try { const item = JSON.parse(line); if (!/^media/.test(item.event)) log('attend:', item.event, item.status || item.trigger || item.message || ''); } catch {} } });
attend.stderr.on('data', data => log('attend!', data.toString().trim().slice(0, 200)));
const joined = await new Promise(resolve => { const timer = setTimeout(() => resolve(false), 150000); attend.stdout.on('data', data => { if (data.toString().includes('"event":"joined"')) { clearTimeout(timer); resolve(true); } }); attend.on('exit', () => { clearTimeout(timer); resolve(false); }); });
if (!joined) { log('robot did not join'); attend.kill('SIGTERM'); process.exit(1); }
results.checks.X1_no_share_at_join = { sharing: (await api('/api/state')).meeting.sharing };
log('robot joined; sharing at join =', results.checks.X1_no_share_at_join.sharing);

// ---- observer
const profile = process.env.OBSERVER_PROFILE || app + 'data/observer-profile';
if (!existsSync(profile)) { cpSync(app + 'data/browser-profile', profile, { recursive: true }); for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(`${profile}/${lock}`, { force: true }); }
const context = await chromium.launchPersistentContext(profile, {
  executablePath: '/usr/bin/google-chrome', headless: false, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', PULSE_SINK: 'robomeet_null' },
  ignoreDefaultArgs: ['--enable-automation', '--password-store=basic', '--use-mock-keychain'], permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 900 },
  args: ['--disable-blink-features=AutomationControlled', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${app}tools/latency/silence.wav%noloop`, '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1600,1000', '--window-position=300,60'],
});
await context.addInitScript({ path: here + 'observer-present-hooks.js' });
const page = await context.newPage();
const shot = name => page.screenshot({ path: join(out, `obs-${name}.png`) }).catch(() => {});
const observer = fn => page.evaluate(fn);
let screenId = null;
try {
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const callout = page.getByRole('button', { name: /^Got it$/i }).first();
  await callout.waitFor({ state: 'visible', timeout: 4000 }).then(() => callout.click()).catch(() => {});
  let joinButton = page.getByRole('button', { name: /^(Join here too|Join now|Join anyway|Ask to join)$/i }).first();
  if (!(await joinButton.isVisible().catch(() => false))) {
    const other = page.getByText(/^Other ways to join$/i).first();
    if (await other.isVisible().catch(() => false)) { await other.click(); await page.waitForTimeout(800); }
    joinButton = page.getByRole('menuitem', { name: /Join here too/i }).first();
    if (!(await joinButton.isVisible().catch(() => false))) joinButton = page.getByText(/Join here too/i).first();
  }
  await joinButton.waitFor({ state: 'visible', timeout: 20000 });
  await joinButton.click();
  await page.getByRole('button', { name: /^(Leave call|Leave meeting)/i }).first().waitFor({ state: 'visible', timeout: 60000 });
  log('observer in the call');
  await sleep(4000);
  await shot('incall');

  // ---- share on (TC-L2): present the deck with sharing
  const shareAt = Date.now();
  await api('/api/command', { type: 'present-deck', slug, enabled: true });
  const commandMs = Date.now() - shareAt;
  let firstFrameMs = null;
  for (let i = 0; i < 60 && !screenId; i++) {
    await sleep(250);
    const found = await page.evaluate(() => window.__pobsApi.screenTrackId());
    if (found && found.stat?.frameWidth >= 1000) { screenId = found.id; results.screenTrack = found; firstFrameMs = Date.now() - shareAt; }
  }
  results.checks.L2_share = { commandMs, firstWideFrameMs: firstFrameMs, how: results.screenTrack?.how || null };
  log('share on: command', commandMs, 'ms; observer sees a presentation after', firstFrameMs, 'ms via', results.screenTrack?.how);
  await sleep(6000);
  await shot('presenting');

  // ---- received quality (TC-R5) + the robot's own encoder view (TC-R1)
  const inbound = (await page.evaluate(() => window.__pobsApi.stats())).find(item => item.trackIdentifier === screenId) || null;
  const diagnostics = await api('/api/diagnostics').catch(error => ({ error: error.message }));
  results.checks.R5_received = inbound;
  results.checks.R1_sent = { stats: diagnostics.stageStats, stage: diagnostics.stage && { contentHint: diagnostics.stage.contentHint, sharing: diagnostics.stage.sharing, displayRequests: diagnostics.stage.displayRequests, lastConstraints: diagnostics.stage.lastConstraints, constraintLog: diagnostics.stage.constraintLog, fps: diagnostics.stage.fps } };
  const frame = screenId ? await page.evaluate(id => window.__pobsApi.grab(id), screenId) : null;
  if (frame) {
    const file = join(out, 'received-view-0.png');
    writeFileSync(file, Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    results.checks.R5_still = { size: `${frame.width}x${frame.height}`, ...score(file, join(app, 'public/slides', slug, 'page-1-view-1.png')) };
  }
  log('received', JSON.stringify(inbound), '| still', JSON.stringify(results.checks.R5_still));
  log('sent (robot side)', JSON.stringify(results.checks.R1_sent).slice(0, 600));

  // ---- moves (TC-L1, TC-S3)
  results.checks.L1_moves = [];
  const deck = JSON.parse(readFileSync(join(app, 'public/slides', slug, 'deck.json'), 'utf8'));
  const views = deck.slides[0].views.length;
  // A deck of whole slides (one view each, e.g. a .pptx with fit page) moves slide to slide; a document scrolls views.
  const bySlide = views === 1 && deck.slides.length > 1;
  for (const step of [1, 2, 0]) {
    const target = bySlide ? { slide: Math.min(step, deck.slides.length - 1), view: 0 } : { slide: 0, view: Math.min(step, views - 1) };
    const at = Date.now();
    await api('/api/command', { type: 'stage', ...target });
    await sleep(4000);
    const change = await page.evaluate(([id, since]) => window.__pobsApi.change(id, since), [screenId, at]);
    results.checks.L1_moves.push({ ...target, ...change });
    log(`move to ${bySlide ? `slide ${target.slide}` : `view ${target.view}`}:`, JSON.stringify(change));
  }

  // ---- TC-P6: a long jump (first window to the last and back) versus the short moves above; JUMP=1
  if (process.env.JUMP === '1') {
    results.checks.P6_jumps = [];
    const last = views - 1;
    for (const view of [last, 0, Math.min(3, last), last]) {
      const at = Date.now();
      await api('/api/command', { type: 'stage', slide: 0, view });
      await sleep(5000);
      const change = await page.evaluate(([id, since]) => window.__pobsApi.change(id, since), [screenId, at]);
      results.checks.P6_jumps.push({ view, ...change });
      log(`jump to view ${view}:`, JSON.stringify(change));
    }
  }
  // ---- TC-P3a live: a highlight on the view on screen reaches the participant; HIGHLIGHT=<phrase>
  if (process.env.HIGHLIGHT) {
    await api('/api/command', { type: 'stage', slide: 0, view: 0 });
    await sleep(3000);
    const at = Date.now();
    await api('/api/command', { type: 'highlight', phrase: process.env.HIGHLIGHT });
    await sleep(2500);
    const change = await page.evaluate(([id, since]) => window.__pobsApi.change(id, since, 0.3), [screenId, at]); // a thin box is a small change
    results.checks.P3_highlight = { phrase: process.env.HIGHLIGHT, ...change };
    log('highlight:', JSON.stringify(results.checks.P3_highlight));
    await shot('highlight');
    await api('/api/command', { type: 'highlight', off: true });
    await sleep(1500);
  }

  // ---- share off/on cycles (TC-X2)
  results.checks.X2_cycles = [];
  for (let i = 0; i < cycles; i++) {
    const cycle = { i };
    try {
      const offAt = Date.now();
      await api('/api/command', { type: 'share', enabled: false });
      cycle.offMs = Date.now() - offAt;
      await sleep(2500);
      const last = await page.evaluate(id => window.__pobsApi.lastFrameAt(id), screenId);
      cycle.observerStoppedReceiving = !last || Date.now() - last > 1500;
      cycle.robotSharingAfterOff = (await api('/api/state')).meeting.sharing;
      const onAt = Date.now();
      await api('/api/command', { type: 'share', enabled: true });
      cycle.onMs = Date.now() - onAt;
      let seen = null;
      for (let k = 0; k < 40 && !seen; k++) { await sleep(250); const found = await page.evaluate(() => window.__pobsApi.screenTrackId()); if (found && found.stat?.frameWidth >= 1000 && (await page.evaluate(id => window.__pobsApi.lastFrameAt(id), found.id)) > onAt) { seen = found; screenId = found.id; } }
      cycle.observerSeesAgainMs = seen ? Date.now() - onAt : null;
      cycle.robotSharingAfterOn = (await api('/api/state')).meeting.sharing;
      cycle.ok = cycle.observerStoppedReceiving && !cycle.robotSharingAfterOff && Boolean(seen) && cycle.robotSharingAfterOn;
    } catch (error) { cycle.error = String(error.message).slice(0, 200); cycle.ok = false; }
    results.checks.X2_cycles.push(cycle);
    log(`cycle ${i}:`, JSON.stringify(cycle));
    await sleep(1500);
  }

  // ---- TC-P1d: the observer plays the coding agent. It asks the robot to delegate, answers after JOB_MS, and asks an
  // unrelated question 20 s into the wait: the robot should answer it within 3 s, and speak the result when it lands.
  if (voice && process.env.DELEGATE === '1') {
    const jobMs = Number(process.env.JOB_MS || 60000);
    const clipOf = name => [...readFileSync(join(here, 'clips', `${name}.wav`))];
    const heard = () => page.evaluate(() => window.__pobs.audio);
    const startCursor = (await api('/api/state')).cursor;
    const p1 = { jobMs };
    const asked = await page.evaluate(bytes => window.__pobsApi.say(bytes), clipOf('delegate'));
    p1.askedEndAt = asked.endAt;
    let job = null;
    for (let i = 0; i < 60 && !job; i++) {
      const batch = await api(`/api/listen?after=${startCursor}&timeout=1000&types=agent.request`);
      job = batch.jobs.find(item => Date.parse(item.createdAt) >= asked.startAt - 1000) || null;
    }
    if (!job) { p1.error = 'the robot did not delegate'; log('P1: no job'); }
    else {
      p1.jobAt = Date.parse(job.createdAt); p1.request = job.request.slice(0, 200);
      log('P1: job', Math.round((p1.jobAt - asked.endAt) / 100) / 10, 's after the ask:', job.request.slice(0, 80));
      await sleep(Math.max(0, p1.jobAt + 20000 - Date.now()));
      // wait for a quiet room (up to 8 s) so the question is not talked over
      for (let i = 0; i < 40; i++) { const a = await heard(); if (!a.length || a.at(-1).phase === 'offset') break; await sleep(200); }
      const q = await page.evaluate(bytes => window.__pobsApi.say(bytes), clipOf('question'));
      p1.questionEndAt = q.endAt;
      await sleep(8000);
      const answer = (await heard()).find(item => item.phase === 'onset' && item.at > q.startAt + 300);
      p1.answerAfterQuestionMs = answer ? answer.at - q.endAt : null;
      log('P1: robot answered the question', p1.answerAfterQuestionMs, 'ms after it ended');
      await sleep(Math.max(0, p1.jobAt + jobMs - Date.now()));
      p1.repliedAt = Date.now();
      await api('/api/command', { type: 'reply', jobId: job.id, result: 'There are 21 test files in the RoboMeet project, under the test folder.' });
      for (let i = 0; i < 30; i++) { await sleep(1000); const a = await heard(); if (a.some(item => item.phase === 'onset' && item.at > p1.repliedAt)) break; }
      const spoken = (await heard()).find(item => item.phase === 'onset' && item.at > p1.repliedAt);
      p1.resultSpokenAfterMs = spoken ? spoken.at - p1.repliedAt : null;
      const delivered = (await api(`/api/listen?after=${startCursor}&timeout=0&types=voice.job_result_delivered`)).events;
      p1.delivered = delivered.map(event => event.data);
      await sleep(6000);
      p1.transcript = (await api(`/api/listen?after=${startCursor}&timeout=0&types=transcript`)).events.map(event => `${event.data.role}: ${event.data.text}`).join(' | ').slice(-3000);
      log('P1: result spoken', p1.resultSpokenAfterMs, 'ms after the reply; delivered', JSON.stringify(p1.delivered));
    }
    results.checks.P1_delegation = p1;
  }
  // ---- TC-P2 live: where can the robot get help? Both the backend reasoning model and the coding session.
  if (voice && process.env.HELP === '1') {
    const startCursor = (await api('/api/state')).cursor;
    await page.evaluate(bytes => window.__pobsApi.say(bytes), [...readFileSync(join(here, 'clips', 'help.wav'))]);
    await sleep(14000);
    const answer = (await api(`/api/listen?after=${startCursor}&timeout=0&types=transcript`)).events.filter(event => event.data.role === 'assistant').map(event => event.data.text).join('');
    results.checks.P2_help = { answer, backend: /backend|reasoning|gpt-5/i.test(answer), coding: /coding (agent|session)/i.test(answer) };
    log('P2:', JSON.stringify(results.checks.P2_help));
  }
  // ---- TC-P3b live: the observer asks the robot to point at equation three (projectile deck, part 1)
  if (voice && process.env.POINT === '1') {
    await api('/api/command', { type: 'stage', slide: 0, view: 0 });
    await sleep(3000);
    const startCursor = (await api('/api/state')).cursor;
    const said = await page.evaluate(bytes => window.__pobsApi.say(bytes), [...readFileSync(join(here, 'clips', 'point.wav'))]);
    let pointer = null;
    for (let i = 0; i < 25 && !pointer; i++) { await sleep(1000); pointer = (await api(`/api/listen?after=${startCursor}&timeout=0&types=presentation.pointer`)).events.find(event => !event.data.off) || null; }
    const change = pointer ? await page.evaluate(([id, since]) => window.__pobsApi.change(id, since, 0.3), [screenId, Date.parse(pointer.at)]) : null;
    results.checks.P3_point = { pointer: pointer?.data ?? null, pointedAfterAskMs: pointer ? Date.parse(pointer.at) - said.endAt : null, frame: change };
    log('P3: pointer', JSON.stringify(results.checks.P3_point));
    await sleep(3000);
    await shot('pointed');
  }
  // ---- narration sync (TC-S1, S2, L3), voice only
  if (narrate) {
    const beats = [
      { slide: 0, view: 0, say: 'This page derives projectile motion from Newton\'s second law. A point mass leaves the origin with speed v zero at angle theta, gravity pulls down, and air resistance is ignored. The blue box gives the law in each direction: nothing horizontally, minus m g vertically. Integrating twice gives x equals v zero cos theta times t, and y equals v zero sine theta times t minus one half g t squared.' },
      { slide: 0, view: 1, say: 'Eliminating t gives the trajectory, a parabola through the origin. Then come the three results: time of flight T equals two v zero sine theta over g, maximum height H equals v zero squared sine squared theta over two g, and range R equals v zero squared sine two theta over g.' },
      { slide: 0, view: Math.min(2, views - 1), say: 'The observations box sums it up: the range is largest at forty-five degrees, complementary angles share the same range, doubling v zero quadruples both range and height, and mass never appears. The flight is symmetric, and the checks at ninety and zero degrees behave as expected.' },
    ];
    const state = await api('/api/state');
    if (state.voice.status !== 'active') log('voice not active, narration skipped:', state.voice.status);
    else {
      const startAt = Date.now();
      const cursorAtStart = state.cursor;
      await api('/api/command', { type: 'narrate', beats, style: 'own-words' });
      const deadline = Date.now() + 180000;
      // INTERRUPT=1: two seconds into the robot's second beat the observer asks a question, lets the robot answer,
      // then says "Okay, continue." (TC-S4).
      const interrupt = process.env.INTERRUPT === '1' ? { armed: true } : null;
      const skip = process.env.NEXT_MID === '1' ? { armed: true } : null; // TC-S2 under a move mid-part
      const clip = name => [...readFileSync(join(here, 'clips', `${name}.wav`))];
      let done = false;
      while (Date.now() < deadline && !done) {
        await sleep(interrupt?.armed || skip?.armed ? 250 : 1000);
        const now = await api('/api/state');
        if (skip?.armed && now.presenter?.beat === 0 && now.presenter?.status === 'running') {
          const onset = (await page.evaluate(() => window.__pobs.audio)).find(item => item.phase === 'onset' && item.at > Date.now() - 6000);
          if (onset && Date.now() - onset.at >= 3000) {
            skip.armed = false;
            skip.at = Date.now();
            await api('/api/command', { type: 'presenter', action: 'next' });
            skip.commandMs = Date.now() - skip.at;
            log('observer: presenter next, 3 s into part 1');
          }
        }
        if (interrupt?.armed && now.presenter?.beat === 1 && now.presenter?.status === 'running') {
          interrupt.beatSeenAt ??= Date.now(); // only the robot's speech after part 2 began counts (not part 1's)
          const onset = (await page.evaluate(() => window.__pobs.audio)).find(item => item.phase === 'onset' && item.at > Math.max(Date.now() - 4000, interrupt.beatSeenAt));
          if (onset && Date.now() - onset.at >= 2000) {
            interrupt.armed = false;
            interrupt.question = await page.evaluate(bytes => window.__pobsApi.say(bytes), clip('interrupt'));
            log('observer asked a question at', new Date(interrupt.question.startAt).toISOString());
            // wait for the robot to answer and go quiet for 1.5 s (max 25 s), then say continue
            const answerDeadline = Date.now() + 25000;
            let quietSince = null;
            while (Date.now() < answerDeadline) {
              await sleep(200);
              const audio = await page.evaluate(() => window.__pobs.audio);
              const last = audio.at(-1);
              const speaking = last && last.phase === 'onset';
              if (!speaking && audio.some(item => item.phase === 'onset' && item.at > interrupt.question.endAt)) { quietSince ??= Date.now(); if (Date.now() - quietSince > 1500) break; } else quietSince = null;
            }
            interrupt.pausedState = (await api('/api/state')).presenter;
            interrupt.continued = await page.evaluate(bytes => window.__pobsApi.say(bytes), clip('continue'));
            log('observer said continue; presenter was', JSON.stringify(interrupt.pausedState));
          }
        }
        done = ['done', 'stopped'].includes(now.presenter?.status) || (now.presenter?.status === 'paused' && !interrupt?.armed && Date.now() - (interrupt?.continued?.endAt || 0) > 20000);
        if (now.presenter?.status === 'paused') log('presenter paused:', now.presenter.reason);
      }
      if (interrupt) results.checks.S4_interrupt = interrupt;
      if (skip?.at) {
        // From the observer's side: when the robot's voice stopped after the command, and when part 2 began.
        const heard = (await page.evaluate(() => window.__pobs.audio)).filter(item => item.at >= skip.at - 500);
        const stop = heard.find(item => item.phase === 'offset' && item.at >= skip.at);
        const next = heard.find(item => item.phase === 'onset' && item.at > (stop?.at ?? skip.at));
        const moved = await page.evaluate(([id, since]) => window.__pobsApi.change(id, since), [screenId, skip.at]);
        results.checks.S5_next = { ...skip, robotStoppedMs: stop ? stop.at - skip.at : null, part2StartedMs: next ? next.at - skip.at : null, screenFirstChangeMs: moved?.firstChangeMs ?? null };
        log('next mid-part:', JSON.stringify(results.checks.S5_next));
      }
      const endAt = Date.now();
      const events = [];
      for (let after = cursorAtStart, page = 0; page < 50; page++) {
        const batch = await api(`/api/listen?after=${after}&timeout=0&types=${encodeURIComponent('presenter.started,presenter.beat,presenter.beat_done,presenter.paused,presenter.resumed,presenter.retry,presenter.done,presenter.stopped,presenter.error,stage-shown,stage-speech')}`);
        events.push(...batch.events);
        if (!batch.events.length || batch.cursor === after) break;
        after = batch.cursor;
      }
      const audio = (await page.evaluate(() => window.__pobs.audio)).filter(item => item.at >= startAt);
      const changes = await page.evaluate(([id, from, to]) => window.__pobsApi.changesBetween(id, from, to), [screenId, startAt, endAt]);
      results.checks.S_narration = { startAt, endAt, presenterEvents: events.map(event => ({ type: event.type, at: event.at, data: event.data })), observerAudio: audio, observerScreenChanges: changes };
      log('narration events', events.length, 'audio onsets', audio.filter(item => item.phase === 'onset').length, 'screen changes', changes.length);
    }
  }
  await shot('end');
} catch (error) { log('observer error:', String(error.message).split('\n')[0]); await shot('error'); results.error = String(error.message).split('\n')[0]; }
try { const leave = page.getByRole('button', { name: /^(Leave call|Leave meeting)/i }).first(); if (await leave.isVisible().catch(() => false)) { await leave.click(); await page.waitForTimeout(2500); } } catch {}
await context.close().catch(() => {});
attend.kill('SIGTERM');
await new Promise(resolve => { attend.on('exit', resolve); setTimeout(resolve, 20000); });
const after = await api('/api/state').catch(() => ({}));
results.voiceSessions = (after.events || []).filter(event => ['voice.created', 'voice.closed', 'voice.control_lost', 'voice.control_reattached'].includes(event.type) && Date.parse(event.at) >= t0).map(event => ({ type: event.type, at: event.at, data: event.data }));
results.serverErrors = (after.events || []).filter(event => ['server.error', 'presentation-failed', 'presentation-retry', 'presentation-stop-fallback', 'stage-error'].includes(event.type) && Date.parse(event.at) >= t0).map(event => ({ type: event.type, at: event.at, data: event.data }));
results.attend = attendLog.filter(line => !line.includes('"event":"media'));
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(join(out, 'log.txt'), lines.join('\n') + '\n');
log('wrote', out);
