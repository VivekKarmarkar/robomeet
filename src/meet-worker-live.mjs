// Single-hop voice worker (integrated 2026-09-14 from the latency workflow's draft).
// Fork of src/meet-worker.mjs (left unchanged; same interface and states — the precedent set by
// src/meet-bridge-worker.mjs). Every difference is marked "single-hop":
//   - injects src/meet-live.js after src/meet-media.js, so the GPT Live WebRTC session runs inside the Meet
//     page: meeting audio -> model and model audio -> fake microphone, without the local bridge round trip;
//   - loads the renderer at /?canvas=1 instead of /?meeting=1, so public/app.js keeps drawing the face and the
//     slide canvas (still carried over the bridge as video) but never owns a voice session;
//   - src/in-page-voice.mjs creates, heartbeats and tears down the paid session from Node.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { prepareBrowserProfile } from './browser-profile.mjs';
import { createInPageVoice } from './in-page-voice.mjs'; // single-hop

const mediaScript = fileURLToPath(new URL('./meet-media.js', import.meta.url));
const liveScript = fileURLToPath(new URL('./meet-live.js', import.meta.url)); // single-hop
const dataDir = process.env.ROBO_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)); // single-hop: control token
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const joinButtonName = /^(Ask to join(?: anyway)?|Join now|Join the call now|Join anyway|Join here too)$/i;

// This code executes only in the app renderer owned by this worker.
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
    transceivers[role] = peer.addTransceiver(tracks[role], {
      direction: role === 'audio' ? 'sendrecv' : 'sendonly',
      streams: [new MediaStream([tracks[role]])],
    });
  }
  peer.ontrack = ({ track }) => {
    if (track.kind === 'audio') window.robotApp.setMeetingInput(new MediaStream([track]));
  };
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) window.__robomeetSignal({ epoch, candidate: candidate.toJSON() }).catch(() => {});
  };
  window.__robomeetAppBridge = {
    epoch,
    async addCandidate(item) {
      if (item.epoch !== epoch) return;
      if (!peer.remoteDescription) pending.push(item.candidate);
      else await peer.addIceCandidate(item.candidate);
    },
    async setAnswer(description) {
      await peer.setRemoteDescription(description);
      for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate);
    },
    close() {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.close();
      window.robotApp.setMeetingInput(new MediaStream());
    },
    state() { return peer.connectionState; },
  };
  await peer.setLocalDescription(await peer.createOffer());
  return {
    description: peer.localDescription.toJSON(),
    roles: Object.fromEntries(Object.entries(transceivers).map(([role, item]) => [role, item.mid])),
    epoch,
  };
}

export function createSingleHopWorker({ baseUrl, getState = () => ({}), onState = () => {}, onEvent = () => {} }) {
  let browser;
  let context;
  let appPage;
  let meetingPage;
  let monitor;
  let voice; // single-hop: src/in-page-voice.mjs controller, one per joined meeting
  let generation = 0;
  let bridgeEpoch = 0;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let polling = false;
  let state = { status: 'idle', admitted: false, sharing: false, media: { input: 'no-input' }, voicePath: 'direct' };
  const emit = data => { try { onEvent(data); } catch {} };
  const update = data => { state = { ...state, ...data }; try { onState({ ...state }); } catch {} };
  const status = () => structuredClone(state);

  async function connectBridge(run) {
    if (run !== generation) return;
    const offer = await appPage.evaluate(createAppOffer, ++bridgeEpoch);
    const answer = await meetingPage.evaluate(offer => window.RoboMeetMedia.answer(offer), offer);
    await appPage.evaluate(answer => window.__robomeetAppBridge.setAnswer(answer), answer);
    emit({ type: 'bridge-negotiated', epoch: bridgeEpoch });
  }

  async function reconnectBridge(run) {
    if (reconnecting || run !== generation || reconnectAttempts >= 3) return;
    reconnecting = true;
    reconnectAttempts++;
    emit({ type: 'bridge-reconnecting', attempt: reconnectAttempts });
    try {
      await connectBridge(run);
    } catch (error) {
      emit({ type: 'media-error', message: error.message });
    } finally {
      reconnecting = false;
    }
  }

  async function closeOwnedBrowser() {
    clearInterval(monitor);
    monitor = null;
    const ownedVoice = voice; // single-hop: end the paid session while the page that carries it is still open
    voice = null;
    await ownedVoice?.stop('meeting_closed').catch(() => {});
    const ownedBrowser = browser;
    const ownedContext = context;
    browser = null;
    const ownedApp = appPage;
    const ownedMeet = meetingPage;
    appPage = null;
    meetingPage = null;
    context = null;
    await Promise.allSettled([
      ownedApp?.evaluate(async () => { window.__robomeetAppBridge?.close(); await window.robotApp?.stopVoice?.(); }),
      // single-hop: RoboMeetLive restores the globals it replaced before RoboMeetMedia restores the natives.
      ownedMeet?.evaluate(() => { window.RoboMeetLive?.close(); window.RoboMeetMedia?.close(); }),
    ]);
    // Persistent contexts own their browser process; closing them also flushes profile state.
    if (ownedContext) await ownedContext.close();
    if (ownedBrowser?.isConnected()) await ownedBrowser.close();
  }

  async function finish(status, message) {
    generation++;
    update({ status, admitted: false, sharing: false, ...(message ? { error: message } : {}) });
    await closeOwnedBrowser();
    update({ media: { input: 'no-input', bridge: 'closed' } });
  }

  async function admitted() {
    const leave = meetingPage.getByRole('button', { name: /Leave call|Leave meeting|Exit call/i });
    return await leave.first().isVisible().catch(() => false);
  }

  async function enableInitialInputs() {
    // ROBOMEET_CAMERA=off joins without video (the account's profile picture shows instead of the animated face).
    const controls = process.env.ROBOMEET_CAMERA === 'off' ? [/^Turn on microphone/i, /^Turn off camera/i] : [/^Turn on microphone/i, /^Turn on camera/i];
    for (const name of controls) {
      const button = meetingPage.getByRole('button', { name });
      if (await button.first().isVisible().catch(() => false)) {
        await button.first().click({ timeout: 2000 }).catch(error => emit({ type: 'media-control-error', message: error.message.split('\n')[0] }));
      }
    }
  }

  async function inspectMeeting(run, deadline) {
    if (polling || run !== generation || !meetingPage) return;
    polling = true;
    try {
      if (meetingPage.isClosed()) return await finish('ended', 'The meeting window closed.');
      const media = await meetingPage.evaluate(() => window.RoboMeetMedia?.health()).catch(() => null);
      const live = await meetingPage.evaluate(() => window.RoboMeetLive?.health()).catch(() => null); // single-hop
      if (media) {
        update({ media: { ...media, live } }); // single-hop: meet-media's fields stay as bin/attend.mjs reads them
        if (media.bridge === 'failed' || media.bridge === 'closed') await reconnectBridge(run);
      }
      // Google Meet shows informational pop-ups ("Others may see your video differently") whose "Got it" button
      // covers the call controls and blocks later clicks such as "Stop presenting". Dismiss them as they appear.
      const gotIt = meetingPage.getByRole('button', { name: /^Got it$/i }).first();
      if (await gotIt.isVisible().catch(() => false)) {
        await gotIt.click({ timeout: 2000 }).then(() => emit({ type: 'dialog-dismissed', button: 'Got it' })).catch(() => {});
      }
      if (await admitted()) {
        if (!state.admitted) {
          update({ status: 'joined', admitted: true, error: null });
          emit({ type: 'meeting-admitted' });
          await enableInitialInputs();
        }
        // Participant count (robot included) so callers can start voice when a human is present, not on first speech.
        const participants = await meetingPage.evaluate(() => {
          const ids = new Set([...document.querySelectorAll('[data-participant-id]')].map(element => element.getAttribute('data-participant-id')).filter(Boolean));
          if (ids.size) return ids.size;
          for (const element of document.querySelectorAll('button, [role="button"], [aria-label]')) {
            const label = element.getAttribute('aria-label') || '';
            if (!/people|participants|everyone|in the call/i.test(label)) continue;
            const match = label.match(/(\d+)/) || (element.innerText || '').match(/(\d+)/);
            if (match) return Number(match[1]);
          }
          return null;
        }).catch(() => null);
        if (participants !== state.participants) update({ participants });
        return;
      }
      const text = await meetingPage.locator('body').innerText({ timeout: 2000 });
      if (/you.ve been removed|removed you from (?:the )?(?:call|meeting)/i.test(text)) return await finish('removed', 'The host removed RoboMeet.');
      if (/your host ended|call ended because everyone left|you left the meeting|you left the call/i.test(text)) return await finish('ended');
      if (/you can.t join this (?:video )?call|you cannot join|request (?:was |has been )?denied|denied your request|no one responded|no response to your request/i.test(text)) {
        return await finish('admission_denied', 'Google Meet did not allow this guest to join.');
      }
      if (!state.admitted && Date.now() > deadline) return await finish('admission_timeout', 'The host did not admit RoboMeet before the admission timeout.');
      if (/waiting for the host to join/i.test(text)) update({ status: 'awaiting_host' });
    } catch (error) {
      if (run === generation) emit({ type: 'meeting-inspection-error', message: error.message.split('\n')[0] });
    } finally {
      polling = false;
    }
  }

  async function requestAdmission(run, name) {
    const limit = Date.now() + 60_000;
    let blockedSince = null;
    while (run === generation && Date.now() < limit) {
      if (await admitted()) return;
      const nameInput = meetingPage.locator('input[placeholder="Your name"], input[aria-label="Your name"], input[name="name"]');
      if (await nameInput.first().isVisible().catch(() => false)) await nameInput.first().fill(name);
      const button = meetingPage.getByRole('button', { name: joinButtonName }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 });
        update({ status: 'awaiting_admission' });
        emit({ type: 'admission-requested' });
        return;
      }
      // single-hop: when Meet believes this account is still in the call from another device (a stale session of our
      // own after a quick leave-and-rejoin), it offers only "Switch here", which would end that session; "Join here
      // too" sits under "Other ways to join" and joins alongside it instead. Never click "Switch here".
      const switchHere = meetingPage.getByRole('button', { name: /^Switch here$/i }).first();
      if (await switchHere.isVisible().catch(() => false)) {
        const gotIt = meetingPage.getByRole('button', { name: /^Got it$/i }).first();
        if (await gotIt.isVisible().catch(() => false)) await gotIt.click({ timeout: 2000 }).catch(() => {});
        const other = meetingPage.getByText(/^Other ways to join$/i).first();
        if (await other.isVisible().catch(() => false)) {
          await other.click({ timeout: 3000 }).catch(() => {});
          const joinToo = meetingPage.getByText(/Join here too/i).first();
          if (await joinToo.isVisible({ timeout: 3000 }).catch(() => false)) {
            await joinToo.click({ timeout: 5000 });
            emit({ type: 'join-here-too' });
            update({ status: 'awaiting_admission' });
            emit({ type: 'admission-requested' });
            return;
          }
        }
      }
      const body = await meetingPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      const blocked = /sign in to join this (?:video )?(?:call|meeting)|you can.t join this (?:video )?call|you cannot join this (?:call|meeting)/i.test(body);
      if (blocked) {
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince > 4000) {
          emit({ type: 'join-ui-diagnostic', text: body.replace(/https?:\/\/\S+/g, '[link]').slice(0, 5000) });
          throw new Error('Google Meet reports that this guest cannot join; see the join-ui-diagnostic event for its exact message.');
        }
      } else blockedSince = null;
      await pause(500);
    }
    if (run === generation) {
      const body = await meetingPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      emit({ type: 'join-ui-diagnostic', text: body.replace(/https?:\/\/\S+/g, '[link]').slice(0, 5000) });
      throw new Error('Could not find the Google Meet guest admission button.');
    }
  }

  async function boot(run, url, name) {
    try {
      const launchOptions = {
        executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome',
        headless: process.env.ROBOMEET_HEADLESS === '1',
        env: { ...process.env, DISPLAY: process.env.ROBOMEET_DISPLAY || process.env.DISPLAY || ':1' },
        // Playwright's default --enable-automation makes navigator.webdriver true, and Google Meet then refuses the
        // guest with "You can't join this video call". A/B evidence: work/robomeet-test/automation-flag-probe.mjs.
        // Dedicated profile only: the sign-in done in normal Chrome (bin/login.mjs) encrypts cookies with the OS keyring.
        // Playwright's default --password-store=basic / --use-mock-keychain cannot read them, so Meet would see the
        // profile as signed out. Verified 2026-09-13: with these switches removed the same profile loads signed in.
        ignoreDefaultArgs: process.env.ROBOMEET_PROFILE_DIR
          ? ['--enable-automation', '--password-store=basic', '--use-mock-keychain']
          : ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,800'],
      };
      const contextOptions = { viewport: { width: 1280, height: 800 }, locale: 'en-US', permissions: ['microphone', 'camera'] };
      if (process.env.ROBOMEET_PROFILE_DIR) {
        const profile = await prepareBrowserProfile(process.env.ROBOMEET_PROFILE_DIR);
        const ownedContext = await chromium.launchPersistentContext(profile, { ...launchOptions, ...contextOptions });
        if (run !== generation) { await ownedContext.close(); return; }
        context = ownedContext;
        browser = ownedContext.browser();
        emit({ type: 'browser-profile', mode: 'dedicated-persistent' });
      } else {
        const owned = await chromium.launch(launchOptions);
        if (run !== generation) { await owned.close(); return; }
        browser = owned;
        context = await browser.newContext(contextOptions);
      }
      context.setDefaultTimeout(5000);
      appPage = await context.newPage();
      meetingPage = await context.newPage();
      await meetingPage.addInitScript({ path: mediaScript });
      await meetingPage.addInitScript({ path: liveScript }); // single-hop: after meet-media.js, never before
      await appPage.exposeFunction('__robomeetSignal', async item => {
        if (run === generation && meetingPage) await meetingPage.evaluate(item => window.RoboMeetMedia?.addCandidate(item), item).catch(() => {});
      });
      await meetingPage.exposeFunction('__robomeetSignal', async item => {
        if (run === generation && appPage) await appPage.evaluate(item => window.__robomeetAppBridge?.addCandidate(item), item).catch(() => {});
      });
      await meetingPage.exposeFunction('__robomeetMediaEvent', data => {
        if (run === generation) emit(data);
      });
      await meetingPage.exposeFunction('__robomeetLiveEvent', data => { // single-hop
        if (run === generation) emit(data);
      });
      // single-hop: /?canvas=1 keeps public/app.js off the voice path (it owns voice only under ?meeting=1).
      const rendererUrl = new URL('/?canvas=1', baseUrl);
      if (process.env.ROBOMEET_TEST_MODE === '1') rendererUrl.searchParams.set('devtest', '1');
      await appPage.goto(rendererUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await appPage.waitForFunction(() => window.robotApp?.getOutgoingTracks, undefined, { timeout: 20_000 });
      await appPage.evaluate(() => window.robotApp.ready);
      await meetingPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await meetingPage.waitForFunction(() => window.RoboMeetMedia, undefined, { timeout: 15_000 });
      await connectBridge(run);
      // single-hop: sessions start only once the store says voice.desired === 'started' and the meeting is joined.
      voice = createInPageVoice({ baseUrl, dataDir, getState, getPage: () => meetingPage, emit });
      voice.start();
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
    if (browser || !['idle', 'ended', 'error', 'removed', 'admission_denied', 'admission_timeout'].includes(state.status)) throw new Error('RoboMeet already has an active meeting. Leave it first.');
    const run = ++generation;
    reconnectAttempts = 0;
    state = { status: 'launching', url: target.href, name: String(name).trim().slice(0, 80) || 'RoboMeet AI', admitted: false, sharing: false, error: null, media: { input: 'no-input' }, voicePath: 'direct' };
    update({});
    void boot(run, state.url, state.name);
    return status();
  }

  async function leave() {
    if (!browser && state.status === 'idle') return status();
    update({ status: 'leaving' });
    if (meetingPage && !meetingPage.isClosed()) {
      await meetingPage.getByRole('button', { name: /Leave call|Leave meeting|Exit call/i }).first().click({ timeout: 2000 }).catch(() => {});
    }
    await finish('ended');
    return status();
  }

  async function present({ enabled }) {
    if (!state.admitted || !meetingPage) throw new Error('RoboMeet must be admitted before sharing a presentation.');
    const desired = Boolean(enabled);
    if (state.sharing === desired) return status();
    if (desired) {
      await meetingPage.getByRole('button', { name: /Present now|Share screen|Present screen/i }).first().click({ timeout: 5000 });
      const option = meetingPage.getByText(/^(Your entire screen|Entire screen|A tab|A window)$/i).first();
      if (await option.isVisible().catch(() => false)) await option.click();
      const confirmed = meetingPage.getByText(/^(You.re presenting|You are presenting|Stop presenting|Stop sharing)$/i).first();
      await confirmed.waitFor({ state: 'visible', timeout: 10_000 });
    } else {
      let stop = meetingPage.getByRole('button', { name: /Stop presenting|Stop sharing/i }).first();
      if (!(await stop.isVisible().catch(() => false))) stop = meetingPage.getByText(/^(Stop presenting|Stop sharing)$/i).first();
      await stop.click({ timeout: 5000 });
    }
    update({ sharing: desired });
    emit({ type: 'presentation-changed', enabled: desired });
    return status();
  }

  async function setMode(mode) {
    if (appPage && !appPage.isClosed()) await appPage.evaluate(mode => window.robotApp?.setMode?.(mode), mode);
    // single-hop: the hard audio gates now live in the Meet page.
    if (meetingPage && !meetingPage.isClosed()) await meetingPage.evaluate(mode => window.RoboMeetLive?.setMode(mode), mode).catch(() => {});
    return status();
  }

  async function diagnostics() {
    if (!meetingPage || meetingPage.isClosed()) return { ...status(), publication: [] };
    return {
      ...status(),
      media: await meetingPage.evaluate(() => window.RoboMeetMedia?.health()),
      live: await meetingPage.evaluate(() => window.RoboMeetLive?.health()), // single-hop
      voice: voice?.status() || null, // single-hop
      publication: await meetingPage.evaluate(() => window.RoboMeetMedia?.publicationStats()),
      buttons: await meetingPage.getByRole('button').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length).map(button => button.getAttribute('aria-label') || button.innerText).slice(0, 40)),
    };
  }

  async function diagnosticTone(options = {}) {
    if (process.env.ROBOMEET_TEST_MODE !== '1') throw new Error('Test audio is disabled.');
    if (!state.admitted || !meetingPage) throw new Error('The test participant must be admitted first.');
    // single-hop: the microphone Meet captures is RoboMeetLive's, so the test tone is played there.
    await meetingPage.evaluate(options => window.RoboMeetLive.testTone(options), options);
    return diagnostics();
  }

  return { join, leave, present, setMode, close: leave, status, diagnostics, diagnosticTone };
}
