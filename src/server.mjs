import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { LiveManager } from './live.mjs';
import { createPresenter } from './presenter.mjs'; // stage: narrated presentations (docs/stage-design.md)
import { highlightFor } from './deck-builder.mjs'; // stage: phrase highlights in deck.json views
import { slideAsset, isSlideAsset } from './stage-sync.mjs'; // stage: one rule for picture paths, shared with the stage

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
  // stage: a slide may carry views (regions of its picture that fill the shared screen, in 0..1 of the picture), each
  // with an optional highlight, pixel-exact render (asset), narration (say) and visible text (lines).
  const unit = value => Math.min(1, Math.max(0, Number(value) || 0));
  const cleanRect = rect => { const w = Math.max(0.02, unit(rect?.w) || 1); const h = Math.max(0.02, unit(rect?.h) || 1); return { x: Math.min(1 - w, unit(rect?.x)), y: Math.min(1 - h, unit(rect?.y)), w, h }; };
  const cleanViews = views => Array.isArray(views) && views.length ? views.slice(0, 200).map(view => {
    const out = cleanRect(view);
    // A highlight must be a rectangle; anything else (a phrase, a partial object) would become a whole-page box.
    if (view?.highlight && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(view.highlight[key])))) out.highlight = cleanRect(view.highlight);
    else if (typeof view?.highlight === 'string') { const box = highlightFor(view, view.highlight); if (box) out.highlight = cleanRect(box); } // a phrase on this view's text lines
    if (typeof view?.asset === 'string' && isSlideAsset(slideAsset(view.asset))) out.asset = slideAsset(view.asset);
    if (typeof view?.say === 'string' && view.say.trim()) out.say = view.say.trim().slice(0, 900); // narrate sends at most 900
    if (Array.isArray(view?.lines)) out.lines = view.lines.slice(0, 60).map(line => String(typeof line === 'string' ? line : line?.text || '').slice(0, 240)).filter(Boolean);
    return out;
  }) : undefined;
  const present = async ({ slides, title = '', enabled }) => {
    if (!Array.isArray(slides) || slides.length > 400) throw fail('Provide at most 400 slides.');
    const clean = slides.map(slide => {
      const item = { title: typeof slide.title === 'string' ? slide.title.slice(0, 300) : '', body: typeof slide.body === 'string' ? slide.body.slice(0, 5000) : '' };
      const views = cleanViews(slide.views); // stage:
      if (views) item.views = views;
      return item;
    });
    // stage: remember which meeting the deck belongs to, so a later meeting never opens with it on screen.
    const owner = terminalStates.includes(store.state.meeting.status) ? 'prepared' : store.state.meeting.url || 'prepared';
    stopPresenter('deck_replaced'); // stage: a narrated walk over the old deck must not go on over the new one
    store.update({ slides: clean, title: String(title).slice(0, 300), slideIndex: 0, viewIndex: 0, presentationMeetingUrl: owner }, 'presentation.updated', { count: clean.length });
    await worker?.syncStage?.(); // stage: the deck is on the stage before Meet shows it
    // Sharing needs an admitted robot; before that the deck is ready on the stage and shares when asked.
    if (enabled !== undefined && (store.state.meeting.admitted || !enabled)) await worker?.present({ enabled: Boolean(enabled), slides: clean, title });
    return { displayed: true, slides: clean.length, sharing: Boolean(store.state.meeting.sharing) };
  };
  // stage: a deck built by bin/deck.mjs / src/deck-builder.mjs, read here so big decks never travel in a request body.
  const presentDeck = async ({ slug, enabled }) => {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) throw fail('Deck slug must be lowercase letters, digits and dashes.');
    let deck;
    try { deck = JSON.parse(await readFile(join(publicDir, 'slides', slug, 'deck.json'), 'utf8')); } catch { throw fail(`No deck named ${slug}. Build it first (node bin/deck.mjs build <pdf>).`, 404); }
    return present({ title: deck.title || slug, slides: deck.slides || [], enabled });
  };
  const live = liveFactory ? liveFactory({ store, present }) : new LiveManager({ store, present, maxDurationMs: Math.min(3600000, Math.max(10000, Number(process.env.ROBO_MAX_SESSION_MS || 600000))) });
  const presenter = createPresenter({ store, live, sync: () => worker?.syncStage?.() }); // stage:
  // stage: a narrate that is still sharing or warming up is cancelled by any stop (a new generation).
  let narrateGeneration = 0;
  const stopPresenter = reason => { narrateGeneration++; return presenter.stop(reason); };
  // stage: the coding agent moved the screen during a narrated part: the walk pauses there, it does not talk over it.
  const holdPresenter = async () => { if (presenter.status().status === 'running') await presenter.control('pause', 'screen_moved').catch(() => {}); };
  async function command(input) {
    if (closing) throw fail('Server is shutting down.', 503);
    switch (input.type) {
      case 'join': {
        if (!worker) throw fail('Meeting browser worker is unavailable.', 503);
        const url = new URL(string(input.url, 'Meeting URL', 2048));
        if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) throw fail('Use a Google Meet invitation URL.');
        if (!terminalStates.includes(store.state.meeting.status)) throw fail('Leave the current meeting before joining another.', 409);
        await live.closeAll('new_meeting');
        stopPresenter('new_meeting'); // stage:
        // stage: a deck left from another meeting must not be on screen in this one (a deck prepared before joining stays).
        if (store.state.slides?.length && store.state.presentationMeetingUrl !== 'prepared' && store.state.presentationMeetingUrl !== url.href) {
          store.update({ slides: [], title: '', slideIndex: 0, viewIndex: 0, presentationMeetingUrl: null }, 'presentation.cleared', { reason: 'new_meeting' });
        } else if (store.state.presentationMeetingUrl === 'prepared') {
          store.update({ presentationMeetingUrl: url.href }); // a deck prepared for this meeting belongs to it from now on
        }
        store.update({ meeting: { status: 'launching', url: url.href, name: String(input.name || 'Robomeet AI').slice(0, 80), admitted: false } }, 'meeting.requested', { url: url.href });
        await worker.join({ url: url.href, name: store.state.meeting.name });
        break;
      }
      case 'leave':
        stopPresenter('meeting_left'); // stage:
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
        await holdPresenter(); // stage:
        store.update({ slideIndex: input.index, viewIndex: 0 }, 'presentation.slide', { index: input.index });
        await worker?.syncStage?.(); break; // stage:
      }
      case 'stage': { // stage: move the shared screen to a slide and one of its views (scroll/zoom)
        const slide = input.slide === undefined ? Number(store.state.slideIndex) || 0 : input.slide;
        if (!Number.isInteger(slide) || slide < 0 || slide >= store.state.slides.length) throw fail('Slide index is out of range.');
        const views = store.state.slides[slide].views?.length || 1;
        const view = input.view === undefined ? 0 : input.view;
        if (!Number.isInteger(view) || view < 0 || view >= views) throw fail(`View index is out of range (this slide has ${views}).`);
        await holdPresenter();
        store.update({ slideIndex: slide, viewIndex: view }, 'presentation.stage', { slide, view });
        await worker?.syncStage?.(); break;
      }
      case 'present-deck': await presentDeck(input); break; // stage:
      case 'narrate': { // stage: optional narration per view, then a narrated walk through them
        if (!store.state.slides.length) throw fail('Present a deck first.', 409);
        if (Array.isArray(input.beats)) {
          const slides = structuredClone(store.state.slides);
          for (const beat of input.beats.slice(0, 400)) {
            const slide = slides[beat?.slide];
            if (!slide || !Number.isInteger(beat.view) || beat.view < 0) throw fail('Each beat needs a valid slide and view index.');
            slide.views ??= [{ x: 0, y: 0, w: 1, h: 1 }];
            if (beat.view >= slide.views.length) throw fail(`Slide ${beat.slide} has no view ${beat.view}.`);
            slide.views[beat.view].say = string(beat.say, 'Narration', 900);
          }
          store.update({ slides }, 'presentation.narration', { beats: input.beats.length });
        }
        const generation = ++narrateGeneration;
        presenter.stop('restarted'); // an earlier walk ends now, not after the share warm-up (a "continue" meanwhile would revive it)
        if (!store.state.meeting.sharing && worker) {
          await worker.present({ enabled: true, slides: store.state.slides, title: store.state.title });
          // Meet's presentation connection starts its bandwidth estimate low; give the encoder a moment to sharpen
          // the first page before the robot talks about it (docs/stage-research.md).
          await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(process.env.ROBOMEET_SHARE_WARMUP_MS ?? 3000))));
        }
        if (generation !== narrateGeneration) throw fail('The narrated presentation was stopped before it began.', 409);
        presenter.start({ from: input.from, style: input.style === 'verbatim' ? 'verbatim' : 'own-words' });
        break;
      }
      case 'presenter': { // stage: pause | resume | next | previous | stop | goto
        if (!['pause', 'resume', 'next', 'previous', 'stop', 'goto'].includes(input.action)) throw fail('Presenter action must be pause, resume, next, previous, stop or goto.');
        if (input.action === 'stop') { stopPresenter('stopped'); break; } // also cancels a narrate still warming up
        await presenter.control(input.action, input.beat); break;
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
        // stage: what the meeting page really sends (stage health, Meet's encoder stats for the shared track, buttons).
        if (request.method === 'GET' && url.pathname === '/api/diagnostics') return json(200, (await worker?.diagnostics?.()) || { error: 'No meeting worker.' });
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
    } catch (error) {
      // stage: unexpected failures used to vanish behind the generic message; keep the real reason in the event log.
      if (!error.status) try { store.event('server.error', { path: String(request.url || '').split('?')[0], message: String(error?.message || error).split('\n')[0].slice(0, 300) }); } catch {}
      if (!response.headersSent && !response.destroyed) json(error.status || 500, { error: error.status ? error.message : 'The operation failed. Check the local server and meeting status.' }); else response.end();
    }
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
    if (terminalStates.includes(meeting.status)) { stopPresenter('meeting_ended'); void live.closeAll('meeting_ended'); } // stage: the walk ends with the meeting
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
