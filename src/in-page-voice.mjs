// Node side of single-hop voice (integrated 2026-09-14 from the latency workflow's draft).
// Owns the GPT Live session lifecycle for a Meet page that runs src/meet-live.js:
//   - watches the store (getState, in-process) for voice.desired === 'started' while the meeting is joined,
//   - asks the page for its SDP offer (page.evaluate), relays it to POST /api/live/sessions with the local
//     control token as a bearer (read from data/control-token; the page never sees it, the OpenAI key stays
//     inside src/live.mjs), then hands the SDP answer back with page.evaluate,
//   - posts the 5 s heartbeat that public/live.js used to post, so src/live.mjs's 20 s heartbeat timeout still
//     closes the paid session if this process dies,
//   - deletes the paid session at once when the page's peer connection fails or the page reloads,
//     and mirrors the renderer's fail() by reporting voice-status error, which makes the server drop
//     voice.desired to 'stopped' so bin/attend.mjs can restart voice on presence.
// Same HTTP contract as bin/attend.mjs, bin/command.mjs and src/mcp.mjs; src/server.mjs is not modified.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createInPageVoice({ baseUrl, dataDir, getState, getPage, emit = () => {}, pollMs = 500, heartbeatMs = 5000, fetchImpl = fetch, jitterTargetMs = Number(process.env.ROBOMEET_JITTER_TARGET_MS || 40) }) {
  let token;
  let current = null; // { id, epoch }
  let starting = false;
  let busy = false;
  let poll = null;
  let heartbeat = null;
  let epoch = 0;
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    token ??= (await readFile(join(dataDir, 'control-token'), 'utf8')).trim();
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${response.status}`);
    return data;
  }
  const page = () => {
    const open = getPage();
    if (!open || open.isClosed()) throw new Error('The meeting page is not open.');
    return open;
  };
  const remove = id => api(`/api/live/sessions/${encodeURIComponent(id)}`, undefined, 'DELETE').catch(() => {});

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let state;
      try { state = getState(); } catch { return; }
      const desired = state.voice?.desired === 'started';
      const joined = ['joined', 'awaiting_admission'].includes(state.meeting?.status);
      if (desired && joined && !current && !starting) await begin();
      else if (!desired && (current || starting)) {
        // Stop while a start is in flight: bump the epoch so begin() deletes what it just created.
        if (starting) epoch++;
        await end('stop_requested');
      }
    } finally { busy = false; }
  }
  async function begin() {
    starting = true;
    const run = ++epoch;
    let id = null;
    const startedAt = Date.now();
    try {
      const sdp = await page().evaluate(options => window.RoboMeetLive.createOffer(options), { jitterTargetMs });
      // No prompt field: src/server.mjs then falls back to store.voicePrompt (the voice-prompt command).
      // public/live.js sends prompt = meeting context instead; see the design notes before changing this.
      const result = await api('/api/live/sessions', { sdp });
      id = result.id;
      if (run !== epoch) { await remove(id); return; }
      await page().evaluate(({ id, sdp }) => window.RoboMeetLive.accept(id, sdp), { id, sdp: result.sdp });
      current = { id, epoch: run };
      emit({ type: 'live-session-accepted', sessionId: id, setupMs: Date.now() - startedAt });
      heartbeat = setInterval(() => void beat(run), heartbeatMs);
      heartbeat.unref?.();
    } catch (error) {
      const message = String(error.message).split('\n')[0].slice(0, 500);
      if (/not connected yet/.test(message) && !id) { emit({ type: 'live-session-waiting', message }); return; } // next tick retries
      emit({ type: 'live-session-error', message });
      try { await page().evaluate(() => window.RoboMeetLive?.closeSession('startup_failed')); } catch {}
      if (id) await remove(id);
      await api('/api/command', { type: 'voice-status', status: 'error', error: message }).catch(() => {});
    } finally { starting = false; }
  }
  async function beat(run) {
    if (!current || current.epoch !== run) return;
    let health = null;
    try { health = await page().evaluate(() => window.RoboMeetLive?.health()); } catch {}
    const connection = health?.session?.connection;
    if (!health?.session || connection === 'failed' || connection === 'closed') return end('page_connection_lost');
    try { await api(`/api/live/sessions/${encodeURIComponent(current.id)}/heartbeat`, {}); }
    catch (error) { await end(`heartbeat_rejected: ${String(error.message).slice(0, 120)}`); }
  }
  async function end(reason) {
    const ended = current;
    current = null;
    epoch++;
    clearInterval(heartbeat);
    heartbeat = null;
    if (!ended) return;
    // The page may already be gone (reload, leave); the paid session is deleted regardless.
    try { await page().evaluate(value => window.RoboMeetLive?.closeSession(value), reason); } catch {}
    await remove(ended.id);
    emit({ type: 'live-session-ended', sessionId: ended.id, reason });
  }
  function start() {
    if (poll) return;
    poll = setInterval(() => void tick(), pollMs);
    poll.unref?.();
  }
  async function stop(reason = 'worker_closed') {
    clearInterval(poll);
    poll = null;
    epoch++;
    starting = false;
    await end(reason);
  }
  return { start, stop, end, status: () => ({ sessionId: current?.id || null, starting }) };
}
