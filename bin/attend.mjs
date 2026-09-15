#!/usr/bin/env node
// RoboMeet attend — the robot-side launcher used by the /robomeet skill.
// Ensures the local app is running, joins a Google Meet as the robot (sharing starts off; --share opts in), posts meeting
// context, keeps the robot's audio off the laptop speakers (null sink), then runs a voice policy loop until the
// meeting ends or a signal arrives.
// Talks to the app only through its HTTP contract: GET /api/state and POST /api/command with the local bearer token.
import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const usage = 'Usage: node bin/attend.mjs <meet-url> [--name NAME] [--agent "Claude Code"|"Codex"] [--cwd PATH] [--project NAME] [--session-id ID] [--share] [--no-share] [--session-name NAME] [--display-name NAME] [--no-voice-auto] [--voice-on presence|speech|join] [--camera on|off] [--mute-laptop] [--silence-ms 600000] [--no-greet] [--voice-path direct|bridge] [--purpose TEXT] [--brief TEXT] [--json]';
let options, positionals;
try {
  ({ values: options, positionals } = parseArgs({ allowPositionals: true, options: {
    name: { type: 'string' }, agent: { type: 'string', default: 'Claude Code' }, cwd: { type: 'string', default: process.cwd() },
    project: { type: 'string' }, 'session-id': { type: 'string' }, 'session-name': { type: 'string' }, 'display-name': { type: 'string', default: process.env.ROBOMEET_DISPLAY_NAME || 'Vivek Bot' }, 'voice-on': { type: 'string', default: 'join' }, 'silence-ms': { type: 'string', default: '600000' },
    share: { type: 'boolean', default: false }, 'no-share': { type: 'boolean', default: false }, 'no-voice-auto': { type: 'boolean', default: false }, 'no-greet': { type: 'boolean', default: false }, 'voice-path': { type: 'string', default: process.env.ROBOMEET_VOICE_PATH || 'direct' }, purpose: { type: 'string' }, brief: { type: 'string' },
    camera: { type: 'string', default: 'off' }, 'mute-laptop': { type: 'boolean', default: false }, 'no-mute': { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } }));
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(1); }
const [meetUrl] = positionals;
const sharesAtJoin = options.share && !options['no-share']; // stage: --no-share is still accepted and is the default
if (options.help || !meetUrl) { console.error(usage); process.exit(options.help ? 0 : 1); }

const appDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.ROBO_DATA_DIR || join(appDir, 'data');
const base = new URL(process.env.ROBO_URL || 'http://127.0.0.1:4318');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('RoboMeet attend must target the local app.');
const TERMINAL = ['idle', 'left', 'ended', 'error', 'removed', 'admission_denied', 'admission_timeout'];
const POLL_MS = 1000, FRESH_SPEECH_MS = 3000, JOIN_TIMEOUT_MS = 120000, SERVER_TIMEOUT_MS = 30000;
const silenceMs = Math.max(5000, Number(options['silence-ms']) || 600000);
const ALONE_MS = 30000; // stop voice this long after the robot is the only participant left
const cwd = resolve(options.cwd), project = options.project || basename(cwd);
const sessionName = options['session-name'] || project;
const displayName = options['display-name'];
const platform = /meet\.google\.com/.test(meetUrl) ? 'Google Meet' : /zoom\.us/.test(meetUrl) ? 'Zoom' : 'video';
const identityLine = `I'm ${displayName}, joining this ${platform} meeting, connected to a ${options.agent} session named ${sessionName}, via our in-house RoboMeet software.`;

// ---- logging (one JSON line per event with --json, else a short human line; never the token) ----
function log(event, data = {}) {
  const at = new Date().toISOString();
  if (options.json) return console.log(JSON.stringify({ at, event, ...data }));
  const detail = Object.entries(data).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ');
  console.log(`[attend ${at.slice(11, 19)}Z] ${event}${detail ? ` ${detail}` : ''}`);
}

// ---- HTTP contract (same as bin/command.mjs) ----
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
const getState = () => api('/api/state');
const command = body => api('/api/command', body);
const isDown = error => error.code === 'ENOENT' || error.name === 'TimeoutError' || ['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code);

// ---- interruptible sleep + signals ----
let stopReason = null, wake = () => {};
const sleep = ms => new Promise(done => { wake = done; setTimeout(done, ms); });
const requestStop = reason => { if (!stopReason) { stopReason = reason; wake(); } };
process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));

// ---- audio isolation ----
// The robot's Chrome must never play the call through the laptop speakers: a human in the same room (or the same
// laptop) would feed it back into the meeting as echo. The server is spawned with PULSE_SINK=<null sink>, which
// PulseAudio/PipeWire honour per process, so every robot stream lands on a sink that discards audio. The robot
// still hears everything through WebRTC tracks. Muting the laptop speakers is therefore opt-in (--mute-laptop).
const execFileAsync = promisify(execFile);
const NULL_SINK = process.env.ROBOMEET_NULL_SINK || 'robomeet_null';
async function ensureNullSink() {
  try {
    const { stdout } = await execFileAsync('pactl', ['list', 'short', 'sinks']);
    if (stdout.split('\n').some(line => line.split('\t')[1] === NULL_SINK)) return true;
    await execFileAsync('pactl', ['load-module', 'module-null-sink', `sink_name=${NULL_SINK}`, 'sink_properties=device.description=RoboMeet-Null']);
    log('audio.null_sink_created', { sink: NULL_SINK });
    return true;
  } catch (error) { log('audio.null_sink_unavailable', { message: String(error.message).split('\n')[0] }); return false; }
}
async function setMute(muted) {
  if (!options['mute-laptop']) return;
  try { await execFileAsync('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']); log(muted ? 'laptop.muted' : 'laptop.unmuted'); }
  catch (error) { log('laptop.mute_failed', { message: String(error.message).split('\n')[0] }); }
}

// ---- server ----
// Voice path: 'direct' runs the GPT Live WebRTC session inside the Meet page (single-hop, src/meet-live.js);
// 'bridge' is the original renderer path. A running server on the other path is restarted while idle.
const voicePath = options['voice-path'] === 'bridge' ? 'bridge' : 'direct';
async function ensureServer() {
  try {
    const snapshot = await getState();
    const running = snapshot.meeting?.voicePath === 'direct' ? 'direct' : 'bridge';
    if (running === voicePath) return snapshot;
    if (!TERMINAL.includes(snapshot.meeting?.status)) throw new Error(`The running RoboMeet server uses the ${running} voice path and is in a meeting; stop it first.`);
    log('server.restarting', { from: running, to: voicePath });
    await execFileAsync('pkill', ['-f', 'node bin/start']).catch(() => {});
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) { await sleep(300); try { await getState(); } catch (error) { if (isDown(error)) break; } }
  } catch (error) { if (!isDown(error)) throw error; }
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, 'attend-server.log');
  const out = openSync(logFile, 'a');
  const isolated = await ensureNullSink();
  const env = { ROBOMEET_PROFILE_DIR: 'data/browser-profile', ROBO_BACKEND_MODEL: 'gpt-5.6-sol', ROBOMEET_CAMERA: options.camera === 'on' ? 'on' : 'off', ROBO_MAX_SESSION_MS: '3600000', ...(isolated ? { PULSE_SINK: NULL_SINK } : {}), ...process.env, ROBOMEET_VOICE_IN_PAGE: voicePath === 'direct' ? '1' : '0' };
  log('audio.routing', isolated ? { sink: env.PULSE_SINK } : { sink: 'default (null sink unavailable)' });
  const child = spawn('node', ['bin/start-live.mjs'], { cwd: appDir, env, detached: true, stdio: ['ignore', out, out] });
  child.on('error', error => log('server.spawn_failed', { message: error.message }));
  child.unref();
  closeSync(out);
  log('server.starting', { pid: child.pid, voicePath, log: logFile });
  for (const deadline = Date.now() + SERVER_TIMEOUT_MS; Date.now() < deadline;) {
    await sleep(500);
    if (stopReason) throw new Error(`Interrupted by ${stopReason} while starting the server.`);
    try { const snapshot = await getState(); log('server.ready', { url: base.origin }); return snapshot; }
    catch (error) { if (!isDown(error)) throw error; }
  }
  throw new Error(`RoboMeet server did not become ready within ${SERVER_TIMEOUT_MS / 1000} s; see ${logFile}.`);
}

// ---- join ----
async function joinMeeting() {
  await command({ type: 'join', url: meetUrl, ...(options.name ? { name: options.name } : {}) });
  log('join.requested', { url: meetUrl });
  let last = null;
  for (const deadline = Date.now() + JOIN_TIMEOUT_MS; Date.now() < deadline;) {
    await sleep(POLL_MS);
    if (stopReason) { await command({ type: 'leave' }).catch(() => {}); throw new Error(`Interrupted by ${stopReason} while joining.`); }
    const snapshot = await getState();
    const { status, error } = snapshot.meeting;
    if (status !== last) { last = status; log('meeting.status', { status, ...(error ? { error } : {}) }); }
    if (status === 'joined') return snapshot;
    if (TERMINAL.includes(status)) throw Object.assign(new Error(`Join failed: ${status}${error ? ` (${error})` : ''}`), { exitCode: 2 });
  }
  await command({ type: 'leave' }).catch(() => {});
  throw Object.assign(new Error(`Join timed out after ${JOIN_TIMEOUT_MS / 1000} s.`), { exitCode: 2 });
}

// ---- what the voice model is told: everything it needs to know about itself and its situation, then "be yourself" ----
// Vivek's rule (2026-09-14): give it all the context, at launch, including any extra context the launching session has,
// and let it express itself. No scripted lines. A recap of earlier transcript in the same meeting is added on a rejoin.
async function recapOfThisMeeting() {
  try {
    const { events = [] } = await getState();
    const cutoff = Date.now() - 2 * 3600 * 1000;
    const starts = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === 'meeting.requested' && event.data?.url === meetUrl && Date.parse(event.at) > cutoff);
    if (!starts.length) return '';
    const lines = events.slice(starts[0].index).filter(event => event.type === 'transcript' && event.data?.text).map(event => `${event.data.role === 'assistant' ? 'You' : 'Vivek'}: ${String(event.data.text).trim()}`);
    if (!lines.length) return '';
    // merge consecutive lines from the same speaker, keep the tail
    const merged = [];
    for (const line of lines) { const [who, ...rest] = line.split(': '); const text = rest.join(': '); if (merged.length && merged.at(-1).startsWith(who + ': ')) merged[merged.length - 1] += ' ' + text; else merged.push(line); }
    return merged.join(' | ').slice(-1500);
  } catch { return ''; }
}
function buildBriefing(recap) {
  return [
    `You are ${displayName}, an AI participant in this ${platform} meeting.`,
    `How you exist: you were launched into this meeting by RoboMeet, software we built in house that runs on Vivek's laptop. It puts you in the call, carries your audio, and links you to a coding session.`,
    `Your parts: your voice and live conversation are OpenAI's gpt-live-1, a full-duplex speech model that listens while it speaks and decides its own turns; your voice is ${process.env.ROBO_VOICE || 'marin'}, hard-coded. Behind it is a backend reasoning model, gpt-5.6-sol, OpenAI's strong reasoning model. It does not talk. When you delegate, it receives the conversation so far, thinks, decides whether to use a tool, and hands back text for you to say in your own words. Its tools: take_note saves a meeting note in RoboMeet; present_slides shows a deck on your shared screen (text slides, or picture slides given as image paths); ask_coding_agent sends a request to the coding session and waits for its real answer. If someone asks you something you do not have in your context, delegate it — either to your backend reasoning model or to the coding agent — rather than guessing or saying you do not know.`,
    `The coding session: a ${options.agent} session named ${sessionName}, connected to you through the RoboMeet MCP server. The agent (Claude Code or Codex) and the session name are launch parameters, passed in by whichever session launches you. It works in ${cwd} on the project ${project}. It can read files, run code, build slide decks (including from PDFs) and do research. It also reads the live meeting transcript through the same MCP server, so it knows what is being said, but it only acts when asked through ask_coding_agent.`,
    'While the coding agent works on a request you can keep talking with people; it may take a while, and the answer arrives when it is done.',
    options.camera === 'on' ? 'Your camera shows an animated robot face drawn by the app.' : 'Your camera is off; participants see your profile picture, a robot icon.',
    'You can hear everyone and speak. You cannot see video or open files yourself.',
    // stage: facts about the shared screen (docs/stage-design.md). Sharing starts off unless --share.
    `Your shared screen ${sharesAtJoin ? 'is on from the start' : 'starts off'} and turns on when a deck is presented (your present_slides tool, or the coding session presenting a PDF, a slide deck, a document, a web page or a picture; a document scrolls one screen-sized part at a time). Only the coding session can move it, stop it, or run a narrated presentation, in which RoboMeet shows each part and asks you to present it.`,
    options.purpose ? `Why you are here: ${options.purpose}` : `Why you are here: Vivek sent you from his ${options.agent} session to take part in this meeting: talk with people, take notes, present slides, and hand work to the coding session when asked.`,
    options.brief ? `Extra context from the session that launched you: ${options.brief}` : '',
    recap ? `Earlier in this meeting, before you rejoined (a rejoin starts a fresh session, so this is what was said): ${recap}` : '',
    'The person speaking is Vivek unless told otherwise.',
    'You are in a meeting, so do not disturb it unnecessarily. When someone asks you something, respond immediately with what you know. Be yourself — express yourself freely, say what you think, and do not hold back.',
  ].filter(Boolean).join(' ');
}

// ---- voice policy: start on fresh speech, stop after silence; the app's own duration cap stays the hard ceiling ----
const stats = { joinedAt: null, voiceStarts: 0, voiceStops: 0, seconds: new Map() };
let lastAssistantAt = 0, voiceActiveSince = 0;
function observe({ voice, events = [] }) {
  const seen = (sessionId, seconds) => { if (sessionId && seconds >= 0) stats.seconds.set(sessionId, Math.max(stats.seconds.get(sessionId) || 0, seconds)); };
  seen(voice.sessionId, voice.usage?.seconds);
  for (const event of events) {
    if (event.type === 'transcript' && event.data?.role === 'assistant') lastAssistantAt = Math.max(lastAssistantAt, Date.parse(event.at) || 0);
    if (event.type === 'voice.closed') seen(event.data?.sessionId, event.data?.usage?.seconds);
  }
}
let aloneSince = 0, greeted = false, joinStartUsed = false;
// Voice is up from the moment the robot is in the call (knocking or admitted), so nobody talks into nothing: the
// Meet page already receives the call's audio while it knocks. Once it has been alone for ALONE_MS the session
// stops and voice returns only when someone is present or speaks. The greeting is a spoken cue the model
// phrases itself (Vivek: no scripted lines).
const greetingCue = process.env.ROBOMEET_GREETING || 'Someone just joined the meeting with you.';
const inCall = status => status === 'joined' || status === 'awaiting_admission';
async function policy({ meeting, voice }) {
  const now = Date.now(), media = meeting.media || {};
  const freshSpeech = media.input === 'active' || (media.lastAudibleAt > 0 && now - media.lastAudibleAt <= FRESH_SPEECH_MS);
  const humans = typeof meeting.participants === 'number' ? Math.max(0, meeting.participants - 1) : null;
  const mode = options['voice-on'];
  const joinStart = mode === 'join' && !joinStartUsed && inCall(meeting.status);
  const wanted = joinStart || (mode === 'speech' ? freshSpeech : (humans !== null && humans >= 1) || freshSpeech);
  if (meeting.status === 'joined' && humans === 0) { if (!aloneSince) aloneSince = now; } else aloneSince = 0;
  if (voice.status !== 'active') { voiceActiveSince = 0; greeted = false; }
  if (voice.status === 'idle' && voice.desired !== 'started') {
    if (!inCall(meeting.status) || !wanted) return;
    await command({ type: 'voice-start' });
    await command({ type: 'mode', mode: 'speak' });
    stats.voiceStarts += 1;
    log('voice.start', { trigger: joinStart ? `in call (${meeting.status})` : humans >= 1 && !freshSpeech ? `${humans} human(s) present` : media.input === 'active' ? 'input active' : 'recent speech', session: stats.voiceStarts });
  } else if (voice.status === 'active') {
    if (!voiceActiveSince) voiceActiveSince = now;
    // Greet once per session as soon as someone is there: a counted human, or admission by a host before the count is known.
    if (!greeted && !options['no-greet'] && meeting.status === 'joined' && (humans === null || humans >= 1)) {
      greeted = true;
      await command({ type: 'announce', text: greetingCue, exact: false }).then(() => log('greeted', { humans })).catch(error => log('greet_failed', { message: error.message }));
    }
    if (humans === 0) greeted = false;
    if (aloneSince && now - aloneSince >= ALONE_MS) {
      joinStartUsed = true;
      await command({ type: 'voice-stop' }); stats.voiceStops += 1; log('voice.stop', { trigger: 'robot alone' }); return;
    }
    const lastActivity = Math.max(voiceActiveSince, media.lastAudibleAt || 0, lastAssistantAt);
    if (now - lastActivity < silenceMs) return;
    await command({ type: 'voice-stop' });
    stats.voiceStops += 1;
    log('voice.stop', { trigger: `silence ${Math.round((now - lastActivity) / 1000)}s` });
  }
}

// ---- shutdown ----
async function finish(reason) {
  log('stopping', { reason });
  const snapshot = await getState().catch(() => null);
  const voice = snapshot?.voice || {};
  if (voice.desired === 'started' || ['connecting', 'active', 'closing'].includes(voice.status)) {
    await command({ type: 'voice-stop' }).then(() => { stats.voiceStops += 1; log('voice.stop', { trigger: 'exit' }); }).catch(error => log('voice.stop_failed', { message: error.message }));
  }
  if (snapshot) await command({ type: 'leave' }).then(() => log('left')).catch(error => log('leave_failed', { message: error.message }));
  await setMute(false);
  const voiceSeconds = [...stats.seconds.values()].reduce((sum, value) => sum + value, 0);
  if (options.json) log('summary', { joinedAt: stats.joinedAt, voiceStarts: stats.voiceStarts, voiceStops: stats.voiceStops, voiceSeconds, reason });
  else console.log(`RoboMeet attend: joined at ${stats.joinedAt}; voice sessions started ${stats.voiceStarts}, stopped ${stats.voiceStops}; voice seconds seen ${voiceSeconds}; exit: ${reason}`);
}

// ---- main ----
async function main() {
  await setMute(true);
  await ensureServer();
  let snapshot = await joinMeeting();
  stats.joinedAt = new Date().toISOString();
  log('joined', { url: meetUrl, name: snapshot.meeting.name, at: stats.joinedAt });
  // stage: no sharing at join by default. A deck from an earlier meeting must never open a meeting (test 5).
  if (sharesAtJoin) await command({ type: 'share', enabled: true }).then(() => log('share.on')).catch(error => log('share_failed', { message: error.message }));
  let briefing = buildBriefing(await recapOfThisMeeting());
  // The server refuses a voice prompt over 6000 characters (it would start without one): trim the launching session's
  // free text (brief, then purpose, then the recap) to fit, and say so.
  const LIMIT = 6000;
  if (briefing.length > LIMIT) {
    const before = briefing.length;
    for (const key of ['brief', 'purpose']) {
      const over = briefing.length - LIMIT;
      if (over <= 0 || !options[key]) continue;
      options[key] = `${options[key].slice(0, Math.max(0, options[key].length - over - 3))}...`;
      briefing = buildBriefing(await recapOfThisMeeting());
    }
    if (briefing.length > LIMIT) briefing = `${briefing.slice(0, LIMIT - 3)}...`;
    log('briefing.trimmed', { from: before, to: briefing.length });
  }
  await command({ type: 'context', text: briefing });
  await command({ type: 'voice-prompt', text: briefing }).then(() => log('briefing.sent', { agent: options.agent, session: sessionName, cwd, project, chars: briefing.length, purpose: Boolean(options.purpose), brief: Boolean(options.brief) })).catch(error => log('voice.prompt_failed', { message: error.message }));
  let lastMeeting = snapshot.meeting.status, lastVoice = snapshot.voice.status, pollFailures = 0;
  while (!stopReason) {
    await sleep(POLL_MS);
    if (stopReason) break;
    try { snapshot = await getState(); pollFailures = 0; }
    catch (error) { log('poll_failed', { message: error.message }); if (++pollFailures >= 5) requestStop('server unreachable'); continue; }
    observe(snapshot);
    if (snapshot.meeting.status !== lastMeeting) { lastMeeting = snapshot.meeting.status; log('meeting.status', { status: lastMeeting, ...(snapshot.meeting.error ? { error: snapshot.meeting.error } : {}) }); }
    if (snapshot.voice.status !== lastVoice) { lastVoice = snapshot.voice.status; log('voice.status', { status: lastVoice, ...(snapshot.voice.error ? { error: snapshot.voice.error } : {}) }); }
    if (lastMeeting !== 'joined' && TERMINAL.includes(lastMeeting)) { requestStop(`meeting ${lastMeeting}`); break; }
    if (!options['no-voice-auto']) await policy(snapshot).catch(error => log('policy_failed', { message: error.message }));
  }
  await finish(stopReason);
}

main().catch(async error => {
  log('error', { message: error.message });
  await setMute(false);
  process.exit(error.exitCode || 1);
});
