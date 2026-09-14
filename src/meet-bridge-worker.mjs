// Signed-in meeting worker: the Meet page runs in the user's already signed-in Chrome through the
// RoboMeet Bridge extension; the robot renderer (face, slides, GPT Live) stays in an app-owned browser.
// Same interface and states as createMeetingWorker in meet-worker.mjs, which is left unchanged.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBridgeLink } from './bridge-link.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Renderer-side offer. Same protocol as meet-worker.mjs; duplicated so the tested worker stays untouched.
async function createAppOffer(epoch) {
  await window.robotApp.ready;
  window.__robomeetAppBridge?.close();
  const tracks = await window.robotApp.getOutgoingTracks();
  for (const role of ['audio', 'camera', 'screen']) {
    if (!tracks[role] || tracks[role].readyState !== 'live') throw new Error(`App ${role} track is not live`);
  }
  const peer = new RTCPeerConnection({ iceServers: [] });
  const pending = [];
  const transceivers = {};
  for (const role of ['audio', 'camera', 'screen']) {
    transceivers[role] = peer.addTransceiver(tracks[role], { direction: role === 'audio' ? 'sendrecv' : 'sendonly', streams: [new MediaStream([tracks[role]])] });
  }
  peer.ontrack = ({ track, receiver }) => { if (track.kind === 'audio') { try { receiver.jitterBufferTarget = 10; } catch {} window.robotApp.setMeetingInput(new MediaStream([track])); } };
  peer.onicecandidate = ({ candidate }) => { if (candidate) window.__robomeetSignal({ epoch, candidate: candidate.toJSON() }).catch(() => {}); };
  window.__robomeetAppBridge = {
    epoch,
    async addCandidate(item) { if (item.epoch !== epoch) return; if (!peer.remoteDescription) pending.push(item.candidate); else await peer.addIceCandidate(item.candidate); },
    async setAnswer(description) { await peer.setRemoteDescription(description); for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate); },
    close() { peer.onicecandidate = null; peer.ontrack = null; peer.close(); window.robotApp.setMeetingInput(new MediaStream()); },
    state() { return peer.connectionState; },
  };
  await peer.setLocalDescription(await peer.createOffer());
  return { description: peer.localDescription.toJSON(), roles: Object.fromEntries(Object.entries(transceivers).map(([role, item]) => [role, item.mid])), epoch };
}

export function readBridgeSecret(dataDir = process.env.ROBO_DATA_DIR || join(appRoot, 'data')) {
  try { return readFileSync(join(dataDir, 'bridge-secret'), 'utf8').trim(); }
  catch { throw new Error('RoboMeet Bridge is not set up. Run: node bin/bridge-build.mjs'); }
}

export function createBridgeMeetingWorker({
  baseUrl, onState = () => {}, onEvent = () => {},
  port = Number(process.env.ROBOMEET_BRIDGE_PORT || 4321),
  secret = readBridgeSecret(),
  account = process.env.ROBOMEET_GOOGLE_ACCOUNT ?? 'vivekkmk.assistant@gmail.com',
  connectTimeoutMs = Number(process.env.ROBOMEET_BRIDGE_CONNECT_MS || 40_000),
} = {}) {
  const link = createBridgeLink({ port, secret });
  let renderer;
  let appPage;
  let tab = null;
  let pumpTimer;
  let monitor;
  let generation = 0;
  let bridgeEpoch = 0;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let polling = false;
  let pumping = false;
  let state = { status: 'idle', admitted: false, sharing: false, media: { input: 'no-input' } };
  const emit = data => { try { onEvent(data); } catch {} };
  const update = data => { state = { ...state, ...data }; try { onState({ ...state }); } catch {} };
  const status = () => structuredClone(state);
  const call = (fn, ...args) => (tab ? link.callTab(tab.tabId, fn, ...args) : Promise.reject(new Error('No RoboMeet meeting window is open.')));

  link.listening.catch(error => emit({ type: 'bridge-extension', state: 'unavailable', message: `Bridge port ${port}: ${error.code || error.message}` }));
  link.events.on('connected', info => emit({ type: 'bridge-extension', state: 'connected', version: info.version }));
  link.events.on('disconnected', () => emit({ type: 'bridge-extension', state: 'disconnected' }));
  link.events.on('event', message => {
    if (message.event === 'tab-closed' && tab && message.tabId === tab.tabId) { tab = null; void finish('ended', 'The RoboMeet meeting window was closed.'); }
  });

  // Moves ICE candidates and media events from the Meet window to the renderer and the app log.
  async function pump(run) {
    if (pumping || run !== generation || !tab || !appPage) return;
    pumping = true;
    try {
      const { candidates, events } = await call('drain');
      for (const item of candidates) await appPage?.evaluate(value => window.__robomeetAppBridge?.addCandidate(value), item).catch(() => {});
      for (const data of events) if (run === generation) emit(data);
    } catch {} finally { pumping = false; }
  }

  async function connectBridge(run) {
    if (run !== generation) return;
    const offer = await appPage.evaluate(createAppOffer, ++bridgeEpoch);
    const answer = await call('answer', offer);
    await appPage.evaluate(value => window.__robomeetAppBridge.setAnswer(value), answer);
    emit({ type: 'bridge-negotiated', epoch: bridgeEpoch });
  }

  async function reconnectBridge(run) {
    if (reconnecting || run !== generation || reconnectAttempts >= 3) return;
    reconnecting = true;
    reconnectAttempts++;
    emit({ type: 'bridge-reconnecting', attempt: reconnectAttempts });
    try { await connectBridge(run); } catch (error) { emit({ type: 'media-error', message: error.message }); } finally { reconnecting = false; }
  }

  async function closeOwned() {
    clearInterval(monitor);
    clearInterval(pumpTimer);
    monitor = null;
    pumpTimer = null;
    const ownedTab = tab;
    const ownedRenderer = renderer;
    const ownedApp = appPage;
    tab = null;
    renderer = null;
    appPage = null;
    await Promise.allSettled([
      ownedApp?.evaluate(async () => { window.__robomeetAppBridge?.close(); await window.robotApp?.stopVoice?.(); }),
      ownedTab ? link.callTab(ownedTab.tabId, 'close') : null,
    ]);
    if (ownedTab) await link.rpc('close', { tabId: ownedTab.tabId }).catch(() => {});
    if (ownedRenderer?.isConnected()) await ownedRenderer.close();
  }

  async function finish(status, message) {
    generation++;
    update({ status, admitted: false, sharing: false, ...(message ? { error: message } : {}) });
    await closeOwned();
    update({ media: { input: 'no-input', bridge: 'closed' } });
  }

  async function inspectMeeting(run, deadline) {
    if (polling || run !== generation || !tab) return;
    polling = true;
    try {
      const media = await call('health').catch(() => null);
      if (media) {
        update({ media });
        if (media.bridge === 'failed' || media.bridge === 'closed') await reconnectBridge(run);
      }
      if (await call('admitted')) {
        if (!state.admitted) {
          update({ status: 'joined', admitted: true, error: null });
          emit({ type: 'meeting-admitted' });
          const clicked = await call('enableInputs').catch(error => { emit({ type: 'media-control-error', message: error.message }); return []; });
          if (clicked.length) emit({ type: 'media-controls-enabled', clicked });
        }
        return;
      }
      const text = await call('text');
      if (/you.ve been removed|removed you from (?:the )?(?:call|meeting)/i.test(text)) return await finish('removed', 'The host removed RoboMeet.');
      if (/your host ended|call ended because everyone left|you left the meeting|you left the call/i.test(text)) return await finish('ended');
      if (/you can.t join this (?:video )?call|you cannot join|request (?:was |has been )?denied|denied your request|no one responded|no response to your request/i.test(text)) {
        emit({ type: 'join-ui-diagnostic', text: text.replace(/https?:\/\/\S+/g, '[link]').slice(0, 3000) });
        return await finish('admission_denied', 'Google Meet did not allow this participant to join.');
      }
      if (!state.admitted && Date.now() > deadline) return await finish('admission_timeout', 'The host did not admit RoboMeet before the admission timeout.');
      if (/waiting for the host to join/i.test(text)) update({ status: 'awaiting_host' });
    } catch (error) {
      if (run === generation) emit({ type: 'meeting-inspection-error', message: error.message.split('\n')[0] });
    } finally {
      polling = false;
    }
  }

  // Real input through the extension (debugger protocol). Returns false if the debugger cannot attach.
  async function realInput(actions) {
    try { await link.rpc('input', { tabId: tab.tabId, actions }); return true; }
    catch (error) { emit({ type: 'real-input-unavailable', message: error.message }); return false; }
  }
  const trustedClick = point => realInput([{ kind: 'click', x: point.x, y: point.y }]);

  // Chrome starts Web Audio only after real user input. An F13 keypress (unused by Meet) provides it;
  // an inert-spot click is the fallback. The page's own userActivation flag confirms the result.
  async function activatePage(run) {
    const active = async () => (await call('activation').catch(() => ({}))).hasBeenActive === true;
    if (await active()) return emit({ type: 'page-activation', ok: true, via: 'already-active' });
    await realInput([{ kind: 'key', key: 'F13' }]);
    if (run !== generation) return;
    if (await active()) return emit({ type: 'page-activation', ok: true, via: 'key' });
    const point = await call('inertPoint').catch(() => null);
    if (point) await trustedClick(point);
    emit({ type: 'page-activation', ok: await active(), via: point ? 'click' : 'none' });
  }

  async function requestAdmission(run, name) {
    const limit = Date.now() + 60_000;
    let blockedSince = null;
    let last = '';
    while (run === generation && Date.now() < limit) {
      if (await call('admitted')) return;
      const target = await call('joinTarget', name);
      last = target.text;
      if (target.nameInput) {
        // Guest joins: type the display name as real input so Meet enables its Join button.
        if (await realInput([{ kind: 'click', ...target.nameInput }, { kind: 'text', text: name }])) { await pause(400); continue; }
        const fallback = await call('join', name);
        if (fallback.clicked) {
          update({ status: 'awaiting_admission' });
          emit({ type: 'admission-requested', button: fallback.clicked, trusted: false });
          return;
        }
        await pause(500);
        continue;
      }
      if (target.label) {
        const trusted = await trustedClick(target);
        if (!trusted) await call('join', name);
        update({ status: 'awaiting_admission' });
        emit({ type: 'admission-requested', button: target.label, trusted });
        return;
      }
      const result = { text: target.text };
      const blocked = /sign in to join this (?:video )?(?:call|meeting)|you can.t join this (?:video )?call|you cannot join this (?:call|meeting)/i.test(result.text);
      if (blocked) {
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince > 4000) {
          emit({ type: 'join-ui-diagnostic', text: result.text.replace(/https?:\/\/\S+/g, '[link]').slice(0, 3000) });
          throw new Error('Google Meet reports that this account cannot join; see the join-ui-diagnostic event for its exact message.');
        }
      } else blockedSince = null;
      await pause(500);
    }
    if (run === generation) {
      emit({ type: 'join-ui-diagnostic', text: last.replace(/https?:\/\/\S+/g, '[link]').slice(0, 3000) });
      throw new Error('Could not find the Google Meet join button.');
    }
  }

  async function boot(run, url, name) {
    try {
      await link.listening;
      if (!(await link.waitForConnection(connectTimeoutMs))) {
        throw new Error('RoboMeet Bridge extension is not connected. Keep the signed-in Chrome open with the extension loaded; node bin/bridge-build.mjs prints the one-time steps.');
      }
      if (run !== generation) return;
      const owned = await chromium.launch({
        executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome',
        headless: process.env.ROBOMEET_HEADLESS === '1',
        env: { ...process.env, DISPLAY: process.env.ROBOMEET_DISPLAY || process.env.DISPLAY || ':1' },
        ignoreDefaultArgs: ['--enable-automation'],
        // The renderer talks to a Meet window in another browser, so it must offer real host candidates.
        args: ['--disable-blink-features=AutomationControlled', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,800'],
      });
      if (run !== generation) { await owned.close(); return; }
      renderer = owned;
      const context = await renderer.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', permissions: ['microphone', 'camera'] });
      context.setDefaultTimeout(5000);
      appPage = await context.newPage();
      await appPage.exposeFunction('__robomeetSignal', async item => { if (run === generation && tab) await call('addCandidate', item).catch(() => {}); });
      const rendererUrl = new URL('/?meeting=1', baseUrl);
      if (process.env.ROBOMEET_TEST_MODE === '1') rendererUrl.searchParams.set('devtest', '1');
      await appPage.goto(rendererUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await appPage.waitForFunction(() => window.robotApp?.getOutgoingTracks, undefined, { timeout: 20_000 });
      await appPage.evaluate(() => window.robotApp.ready);
      if (run !== generation) return;
      const target = new URL(url);
      if (account) target.searchParams.set('authuser', account);
      const opened = await link.rpc('open', { url: target.href, role: 'robot', nonce: randomBytes(12).toString('hex'), muted: true, bounds: { width: 1180, height: 820 } });
      if (run !== generation) { await link.rpc('close', { tabId: opened.tabId }).catch(() => {}); return; }
      tab = opened;
      emit({ type: 'browser-profile', mode: 'signed-in-bridge' });
      const readyBy = Date.now() + 30_000;
      while (!(await call('ready').catch(() => false))) {
        if (run !== generation) return;
        if (Date.now() > readyBy) throw new Error('The RoboMeet agent did not load in the Meet window. Reload the extension on chrome://extensions.');
        await pause(300);
      }
      pumpTimer = setInterval(() => void pump(run), 150);
      await activatePage(run);
      await connectBridge(run);
      update({ status: 'joining' });
      await requestAdmission(run, name);
      if (run !== generation) return;
      const deadline = Date.now() + Number(process.env.ROBOMEET_ADMISSION_TIMEOUT_MS || 180_000);
      monitor = setInterval(() => void inspectMeeting(run, deadline), 1000);
      await inspectMeeting(run, deadline);
    } catch (error) {
      if (run === generation) await finish('error', error.message.split('\n')[0]);
    }
  }

  async function join({ url, name = 'RoboMeet AI' }) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'meet.google.com' || target.username || target.password || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(target.pathname)) {
      throw new Error('Enter a Google Meet meeting URL such as https://meet.google.com/abc-defg-hij.');
    }
    if (tab || renderer || !['idle', 'ended', 'error', 'removed', 'admission_denied', 'admission_timeout'].includes(state.status)) throw new Error('RoboMeet already has an active meeting. Leave it first.');
    const run = ++generation;
    reconnectAttempts = 0;
    state = { status: 'launching', url: target.href, name: String(name).trim().slice(0, 80) || 'RoboMeet AI', admitted: false, sharing: false, error: null, media: { input: 'no-input' } };
    update({});
    void boot(run, state.url, state.name);
    return status();
  }

  async function leave() {
    if (!tab && !renderer && state.status === 'idle') return status();
    update({ status: 'leaving' });
    if (tab) await call('leave').catch(() => {});
    await finish('ended');
    return status();
  }

  async function present({ enabled }) {
    if (!state.admitted || !tab) throw new Error('RoboMeet must be admitted before sharing a presentation.');
    const desired = Boolean(enabled);
    if (state.sharing === desired) return status();
    await call('present', desired);
    update({ sharing: desired });
    emit({ type: 'presentation-changed', enabled: desired });
    return status();
  }

  async function setMode(mode) {
    if (appPage && !appPage.isClosed()) await appPage.evaluate(value => window.robotApp?.setMode?.(value), mode);
    return status();
  }

  async function diagnostics() {
    if (!tab) return { ...status(), publication: [], extension: link.connected() };
    return { ...status(), extension: link.connected(), media: await call('health'), publication: await call('publicationStats'), buttons: await call('buttons') };
  }

  async function diagnosticTone(options = {}) {
    if (process.env.ROBOMEET_TEST_MODE !== '1') throw new Error('Test audio is disabled.');
    if (!state.admitted || !appPage) throw new Error('The test participant must be admitted first.');
    await appPage.evaluate(async value => {
      if (!window.robotApp.playTestTone) throw new Error('The app renderer does not expose test audio.');
      await window.robotApp.setMode('speak');
      await window.robotApp.playTestTone(value);
    }, options);
    return diagnostics();
  }

  async function close() {
    await leave().catch(() => {});
    await link.close();
  }

  return { join, leave, present, setMode, close, status, diagnostics, diagnosticTone, extensionConnected: link.connected };
}
