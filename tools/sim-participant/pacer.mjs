// A real-time audio bridge between two GPT Live sessions. One job: be each side's microphone.
//
// Every tick, each side receives exactly one tick of the other side's queued speech, or silence when there is none.
// That is what a real microphone does, and it is what the earlier harness lacked: bursts of synthetic speech followed
// by dead digital air did not reliably mark the end of an utterance. Neither side ever hears itself, as in Meet.
// It also records who was on air at every tick, which is how turns are detected and overlap is measured.
export const RATE = 24000;

export function startPacer(a, b, { tickMs = 100, onAirRms = 300, record = false } = {}) {
  const bytes = Math.round(RATE * 2 * tickMs / 1000);
  const silence = Buffer.alloc(bytes);
  const timeline = [];
  const tape = { a: [], b: [] }; // record: exactly what each side put on air, one tick at a time, aligned by construction
  const state = { a: { on: false, lastOn: 0, lastOff: Date.now() }, b: { on: false, lastOn: 0, lastOff: Date.now() } };
  const take = s => {
    let need = bytes; const parts = [];
    while (need > 0 && s.queue.length) {
      const head = s.queue[0];
      if (head.length <= need) { parts.push(head); need -= head.length; s.queue.shift(); }
      else { parts.push(head.subarray(0, need)); s.queue[0] = head.subarray(need); need = 0; }
    }
    if (!parts.length) return null;
    const out = Buffer.concat(parts);
    return out.length < bytes ? Buffer.concat([out, Buffer.alloc(bytes - out.length)]) : out;
  };
  const rms = buf => { let x = 0; for (let i = 0; i < buf.length; i += 2) { const v = buf.readInt16LE(i); x += v * v; } return Math.sqrt(x / (buf.length / 2)); };
  const mark = (who, on, now) => { const st = state[who]; if (on) st.lastOn = now; else if (st.on) st.lastOff = now; st.on = on; };
  const timer = setInterval(() => {
    const now = Date.now();
    const fromA = take(a), fromB = take(b);
    const aOn = Boolean(fromA && rms(fromA) > onAirRms), bOn = Boolean(fromB && rms(fromB) > onAirRms);
    mark('a', aOn, now); mark('b', bOn, now);
    timeline.push({ t: now, a: aOn ? 1 : 0, b: bOn ? 1 : 0 });
    if (record) { tape.a.push(fromA || silence); tape.b.push(fromB || silence); }
    b.send({ type: 'session.input_audio.append', audio: (fromA || silence).toString('base64') });
    a.send({ type: 'session.input_audio.append', audio: (fromB || silence).toString('base64') });
  }, tickMs);
  timer.unref?.();
  return {
    timeline, state, tape, tickMs,
    // True when this side has spoken since `since` and has been quiet for at least `quietMs` with nothing left queued.
    finished: (who, since, quietMs = 1500) => { const st = state[who], s = who === 'a' ? a : b; return st.lastOn > since && !st.on && !s.queue.length && Date.now() - st.lastOff >= quietMs; },
    speaking: who => state[who].on,
    stop: () => clearInterval(timer),
  };
}

// A mono 16-bit WAV of one side's tape.
export function wav(chunks, rate = RATE) {
  const data = Buffer.concat(chunks);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Overlap and turn statistics over a window of the timeline.
export function turnStats(timeline, from = 0, to = Infinity) {
  const w = timeline.filter(x => x.t >= from && x.t <= to);
  const sec = n => Math.round(n * 10) / 100; // 100 ms ticks -> seconds
  return { aOnAir: sec(w.filter(x => x.a).length), bOnAir: sec(w.filter(x => x.b).length), both: sec(w.filter(x => x.a && x.b).length), ticks: w.length };
}
