// Local link to the RoboMeet Bridge Chrome extension.
// A WebSocket server on 127.0.0.1 that accepts only chrome-extension:// origins presenting the shared secret,
// then carries request/response calls ("open", "call", "close") to the extension's service worker.
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createBridgeLink({ port, secret, host = '127.0.0.1' }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('RoboMeet Bridge secret is missing. Run: node bin/bridge-build.mjs');
  const events = new EventEmitter();
  const pending = new Map();
  const waiters = new Set();
  let link = null;
  let sequence = 0;
  const server = new WebSocketServer({
    host, port, path: '/bridge',
    verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
  });
  const listening = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  listening.catch(() => {});
  server.on('connection', socket => {
    let authenticated = false;
    const timer = setTimeout(() => { if (!authenticated) socket.close(); }, 5000);
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!authenticated) {
        if (message.type !== 'hello' || !equal(message.secret, secret)) return socket.close();
        authenticated = true;
        clearTimeout(timer);
        if (link && link !== socket) link.close();
        link = socket;
        events.emit('connected', { version: message.version });
        for (const resolve of waiters) resolve(true);
        waiters.clear();
        return;
      }
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (message.type === 'event') events.emit('event', message);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (link !== socket) return;
      link = null;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('RoboMeet Bridge extension disconnected.')); }
      pending.clear();
      events.emit('disconnected');
    });
    socket.on('error', () => {});
  });
  // Traffic keeps the extension's service worker alive while the app runs.
  const keepAlive = setInterval(() => { if (link?.readyState === 1) link.send('{"type":"ping"}'); }, 20_000);
  const connected = () => link?.readyState === 1;

  function rpc(method, params = {}, timeout = 15_000) {
    if (!connected()) return Promise.reject(new Error('RoboMeet Bridge extension is not connected.'));
    const id = `${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RoboMeet Bridge call ${method} timed out.`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      link.send(JSON.stringify({ id, method, params }));
    });
  }
  async function callTab(tabId, fn, ...args) {
    const result = await rpc('call', { tabId, fn, args }, fn === 'present' ? 25_000 : 15_000);
    if (result?.missing) throw Object.assign(new Error('The RoboMeet agent is not loaded in that Meet window yet.'), { code: 'AGENT_MISSING' });
    if (result?.error) throw new Error(result.error);
    return result?.value;
  }
  function waitForConnection(milliseconds) {
    if (connected()) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); waiters.delete(done); resolve(value); };
      const timer = setTimeout(() => done(false), milliseconds);
      waiters.add(done);
    });
  }
  async function close() {
    clearInterval(keepAlive);
    for (const resolve of waiters) resolve(false);
    waiters.clear();
    link?.close();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(() => resolve()));
  }
  return { events, listening, connected, rpc, callTab, waitForConnection, close };
}
