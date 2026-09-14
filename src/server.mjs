import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { LiveManager } from './live.mjs';

export const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const terminalStates = ['idle', 'left', 'ended', 'error', 'removed', 'admission_denied', 'admission_timeout'];
const string = (value, name, max = 16000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} must be nonempty text under ${max} characters.`); return value.trim(); };
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(request) {
  let content = '';
  for await (const chunk of request) { content += chunk; if (Buffer.byteLength(content) > 128 * 1024) throw fail('Request is too large.', 413); }
  try { return JSON.parse(content || '{}'); } catch { throw fail('Expected a JSON request.'); }
}
export async function createApp({ port = Number(process.env.ROBO_PORT || 4318), host = '127.0.0.1', dataDir = process.env.ROBO_DATA_DIR || join(appDirectory, 'data'), workerFactory, liveFactory, publicDir = join(appDirectory, 'public') } = {}) {
  const store = new Store(dataDir);
  const tokenFile = join(dataDir, 'control-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : randomBytes(32).toString('hex');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600 });
  let worker, baseUrl, closing = false;
  const clients = new Set();
  const emit = state => {
    const packet = `event: state\nid: ${state.cursor}\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) if (!client.write(packet)) { clients.delete(client); client.end(); }
  };
  store.on('change', emit);
  store.on('telemetry', emit);
  const present = async ({ slides, title = '', enabled }) => {
    if (!Array.isArray(slides) || slides.length > 400) throw fail('Provide at most 400 slides.');
    const clean = slides.map(slide => ({ title: typeof slide.title === 'string' ? slide.title.slice(0, 300) : '', body: typeof slide.body === 'string' ? slide.body.slice(0, 5000) : '' }));
    store.update({ slides: clean, title: String(title).slice(0, 300), slideIndex: 0 }, 'presentation.updated', { count: clean.length });
    if (enabled !== undefined) await worker?.present({ enabled: Boolean(enabled), slides: clean, title });
    return { displayed: true, slides: clean.length };
  };
  const live = liveFactory ? liveFactory({ store, present }) : new LiveManager({ store, present, maxDurationMs: Math.min(3600000, Math.max(10000, Number(process.env.ROBO_MAX_SESSION_MS || 600000))) });
  async function command(input) {
    if (closing) throw fail('Server is shutting down.', 503);
    switch (input.type) {
      case 'join': {
        if (!worker) throw fail('Meeting browser worker is unavailable.', 503);
        const url = new URL(string(input.url, 'Meeting URL', 2048));
        if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) throw fail('Use a Google Meet invitation URL.');
        if (!terminalStates.includes(store.state.meeting.status)) throw fail('Leave the current meeting before joining another.', 409);
        await live.closeAll('new_meeting');
        store.update({ meeting: { status: 'launching', url: url.href, name: String(input.name || 'Robomeet AI').slice(0, 80), admitted: false } }, 'meeting.requested', { url: url.href });
        await worker.join({ url: url.href, name: store.state.meeting.name });
        break;
      }
      case 'leave':
        store.update({ voice: { ...store.state.voice, desired: 'stopped' } }, 'meeting.leaving');
        await live.closeAll('meeting_left');
        await worker?.leave();
        store.update({ meeting: { ...store.state.meeting, status: 'idle', admitted: false } }, 'meeting.left');
        break;
      case 'voice-start':
        if (store.state.voice.desired === 'started') break;
        if (!['joined', 'awaiting_admission'].includes(store.state.meeting.status) && !input.preview) throw fail('Join the meeting before starting voice.', 409);
        store.update({ voice: { desired: 'started', status: 'connecting', preview: Boolean(input.preview) } }, 'voice.requested');
        break;
      case 'voice-prompt': {
        // Text appended to the voice model's instructions when the next session is created (identity, standing facts).
        const text = string(input.text, 'Voice prompt', 6000);
        store.update({ voicePrompt: text }, 'voice.prompt_updated', { chars: text.length }); break;
      }
      case 'voice-stop':
        store.update({ voice: { ...store.state.voice, desired: 'stopped' } }, 'voice.stop_requested');
        await live.closeAll('requested');
        if (!live.sessions?.size) store.update({ voice: { ...store.state.voice, desired: 'stopped', status: 'idle' } });
        break;
      case 'voice-status': {
        if (!['idle', 'connecting', 'active', 'error'].includes(input.status)) throw fail('Unknown voice status.');
        if (input.status === 'active' && store.state.voice.desired !== 'started') break;
        const patch = { ...store.state.voice, status: input.status };
        if (input.error) patch.error = String(input.error).slice(0, 500);
        if (input.status === 'error') { patch.desired = 'stopped'; await live.closeAll('renderer_error'); }
        store.update({ voice: patch }, 'voice.status'); break;
      }
      case 'mode':
        if (!['quiet', 'listen', 'speak'].includes(input.mode)) throw fail('Mode must be quiet, listen or speak.');
        store.update({ mode: input.mode }, 'mode.changed', { mode: input.mode });
        live.setMode(input.mode); await worker?.setMode?.(input.mode); break;
      case 'context': {
        const text = string(input.text, 'Context');
        store.update({ context: text }, 'context.updated', { text }); live.context(text); break;
      }
      case 'announce': {
        // Have the robot say something now (spoken wording is requested exactly; the model may still paraphrase).
        const text = string(input.text, 'Announcement', 600);
        const spoken = await live.announce(text, input.exact !== false);
        if (!spoken) throw fail('No active voice session to speak through.', 409);
        store.event('voice.announced', { chars: text.length }); break;
      }
      case 'present': await present(input); break;
      case 'share':
        if (typeof input.enabled !== 'boolean') throw fail('enabled must be a boolean.');
        await worker?.present({ enabled: input.enabled, slides: store.state.slides, title: store.state.title });
        store.event('presentation.share', { enabled: input.enabled }); break;
      case 'slide': {
        if (!Number.isInteger(input.index) || input.index < 0 || input.index >= store.state.slides.length) throw fail('Slide index is out of range.');
        store.update({ slideIndex: input.index }, 'presentation.slide', { index: input.index }); break;
      }
      case 'note': store.note(string(input.text, 'Note')); break;
      case 'reply': store.reply(string(input.jobId, 'Job ID', 200), string(input.result, 'Result', 32000)); break;
      default: throw fail('Unknown command.');
    }
    return store.snapshot();
  }
  const server = http.createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address()?.port || port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(request.headers.host)) throw fail('Unexpected host.', 403);
      const origin = request.headers.origin;
      if (origin && !hosts.some(allowed => origin === `http://${allowed}`)) throw fail('Unexpected origin.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-site access denied.', 403);
      const url = new URL(request.url, baseUrl);
      if (url.pathname.startsWith('/api/')) {
        const bearer = request.headers.authorization?.replace(/^Bearer /, '');
        const cookie = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('robomeet='))?.slice(9);
        if (!equal(bearer, token) && !equal(cookie, token)) throw fail('Open Robomeet in this browser first, or authenticate with the local control token.', 401);
        if (request.method === 'GET' && url.pathname === '/api/state') return json(200, store.snapshot());
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          response.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
          clients.add(response);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 10000);
          response.on('close', () => { clients.delete(response); clearInterval(heartbeat); }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/listen') {
          const after = Number(url.searchParams.get('after') || 0), timeout = Number(url.searchParams.get('timeout') || 50000);
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(timeout)) throw fail('Invalid cursor or timeout.');
          const types = url.searchParams.has('types') ? url.searchParams.get('types').split(',').filter(Boolean) : undefined;
          if (types && (types.length > 30 || types.some(type => !/^[a-zA-Z0-9_.-]{1,100}$/.test(type)))) throw fail('Invalid event type filter.');
          const abort = new AbortController(); response.on('close', () => abort.abort());
          const result = await store.listen(after, timeout, abort.signal, types);
          if (!response.destroyed) json(200, result); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/command') return json(200, await command(await body(request)));
        if (request.method === 'POST' && url.pathname === '/api/live/sessions') {
          if (store.state.voice.desired !== 'started') throw fail('Start voice explicitly before creating a session.', 409);
          const input = await body(request);
          string(input.sdp, 'SDP offer', 100000); // Validate only: SDP line terminators are protocol data.
          // The stored voice prompt (identity rule, standing facts) takes precedence. The renderer sends the meeting
          // context as its prompt; that is already passed to the session as context, so it is not repeated here.
          const stored = typeof store.state.voicePrompt === 'string' ? store.state.voicePrompt : '';
          const prompt = stored || (typeof input.prompt === 'string' && input.prompt !== store.state.context ? input.prompt : '');
          const result = await live.create({ sdp: input.sdp, prompt });
          if (response.destroyed || store.state.voice.desired !== 'started') { await live.close(result.id, 'creation_abandoned'); return; }
          return json(201, result);
        }
        const match = url.pathname.match(/^\/api\/live\/sessions\/([^/]+)(\/heartbeat)?$/);
        if (match && request.method === 'POST' && match[2]) return json(200, live.heartbeat(decodeURIComponent(match[1])));
        if (match && request.method === 'DELETE' && !match[2]) return json(200, await live.close(decodeURIComponent(match[1]), 'requested'));
        throw fail('API route not found.', 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw fail('Method not allowed.', 405);
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(resolve(publicDir) + sep)) throw fail('Not found.', 404);
      let content; try { content = await readFile(file); } catch { throw fail('Not found.', 404); }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store', 'Set-Cookie': `robomeet=${token}; HttpOnly; SameSite=Strict; Path=/`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!response.headersSent && !response.destroyed) json(error.status || 500, { error: error.status ? error.message : 'The operation failed. Check the local server and meeting status.' }); else response.end(); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (!workerFactory) {
    try { workerFactory = (await import('./meet-worker.mjs')).createMeetingWorker; }
    catch (error) { store.event('meeting.worker_unavailable', { message: 'Meeting worker could not load; install dependencies and check its module.' }); }
  }
  if (workerFactory) worker = await workerFactory({ baseUrl, getState: () => store.snapshot(), onState: patch => {
    const previous = store.state.meeting;
    const meeting = { ...previous, ...patch };
    const stable = value => { const { media, ...rest } = value; return JSON.stringify(rest); };
    if (stable(previous) === stable(meeting)) { store.telemetry({ meeting }); return; }
    store.update({ meeting }, 'meeting.status', { status: meeting.status, admitted: meeting.admitted, sharing: meeting.sharing, error: meeting.error });
    if (terminalStates.includes(meeting.status)) void live.closeAll('meeting_ended');
  }, onEvent: event => store.event(event.type || 'meeting.event', event) });
  return { server, store, live, command, baseUrl, token, async close() {
    if (closing) return; closing = true;
    await live.closeAll('server_shutdown');
    await (worker?.close?.() || worker?.leave?.());
    for (const client of clients) client.end();
    store.off('change', emit);
    store.off('telemetry', emit);
    await new Promise(resolveClose => server.close(resolveClose));
  } };
}
