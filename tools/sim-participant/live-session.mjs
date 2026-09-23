// One GPT Live session over its server-side WebSocket. One job: open it, carry events both ways, keep what came back.
//
// "One connection carries audio and control events" (developers.openai.com/api/docs/guides/voice-websockets). Output
// audio arrives in bursts faster than real time, so it is QUEUED here, not played: whoever consumes it (the pacer)
// decides the timing. Transcripts, function calls from the delegated backend, and errors are kept as they arrive.
import WebSocket from 'ws';

const URL = 'wss://api.openai.com/v1/live/sessions';
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function openLiveSession({ name, config, apiKey = process.env.OPENAI_API_KEY, startTimeoutMs = 20000 }) {
  const socket = new WebSocket(URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  const s = { name, id: null, started: false, closed: false, queue: [], said: '', saidLog: [], heard: '', calls: [], errors: [], listeners: new Set() };
  s.send = payload => { if (socket.readyState === 1) socket.send(JSON.stringify(payload)); };
  s.on = fn => { s.listeners.add(fn); return () => s.listeners.delete(fn); };
  socket.on('message', raw => {
    let e; try { e = JSON.parse(raw.toString()); } catch { return; }
    if (e.type === 'session.started') { s.started = true; s.id = e.session?.id; }
    else if (e.type === 'session.output_audio.delta') s.queue.push(Buffer.from(e.delta, 'base64'));
    else if (e.type === 'session.output_transcript.delta') { s.said += e.delta || ''; s.saidLog.push({ at: Date.now(), text: e.delta || '' }); }
    else if (e.type === 'session.input_transcript.delta') s.heard += e.delta || '';
    else if (e.type === 'session.closed') s.closed = true;
    else if (e.type === 'error') s.errors.push(e.error?.message || JSON.stringify(e).slice(0, 200));
    else if (e.type === 'response.event') {
      const inner = e.event || {};
      if (inner.type === 'response.output_item.done' && inner.item?.type === 'function_call') {
        s.calls.push({ name: inner.item.name, args: inner.item.arguments, callId: inner.item.call_id, at: Date.now() });
      }
    }
    for (const fn of s.listeners) { try { fn(e, s); } catch {} }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  s.send({ type: 'session.start', event_id: `start_${name}`, session: config });
  const deadline = Date.now() + startTimeoutMs;
  while (!s.started && Date.now() < deadline) await wait(50);
  if (!s.started) { socket.close(); throw new Error(`${name}: session never started (${s.errors.join('; ') || 'no error reported'})`); }
  // Text into the model's context without it being spoken on arrival; the Live cap is 500 tokens per append.
  s.think = text => { const t = String(text); for (let i = 0; i < t.length; i += 450) s.send({ type: 'session.thinking.append', delegation_id: null, content: t.slice(i, i + 450) }); };
  s.instruct = text => s.send({ type: 'session.instructions.append', delegation_id: null, content: String(text).slice(0, 1800) });
  s.nudge = () => s.send({ type: 'session.commentary.append', delegation_id: null, content: 'Begin now, following the instructions provided.' });
  s.close = async () => { s.send({ type: 'session.close' }); const end = Date.now() + 5000; while (!s.closed && Date.now() < end) await wait(100); socket.close(); };
  return s;
}
