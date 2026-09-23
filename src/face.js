/*
 * An animated cartoon face on a canvas, driven in real time by speech audio. One job.
 *
 * Injected into a page the same way src/meet-stage.js is: an IIFE that exposes window.RoboMeetFace. It draws on its
 * own canvas and hands out a video track (captureStream), so whoever owns a camera can show it. It knows nothing
 * about Meet, GPT Live or RoboMeet: it is told how loud the speech is, or given an audio track to measure, and it
 * moves its mouth, blinks, and looks alive.
 *
 * Mouth shape comes from the sound itself: loudness opens the mouth, and the balance of low to high frequencies
 * rounds it ("oh") or widens it ("ee"). Frames run on a timer, not requestAnimationFrame, because an automated tab
 * is often treated as hidden and animation frames are throttled there.
 */
(() => {
  if (window.RoboMeetFace) return;
  const TAU = Math.PI * 2;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  const CHARACTERS = {
    robot: { name: 'Vivek Bot', bg: ['#0f1b2d', '#16283f'], head: '#2b3a4f', rim: '#40536b', eye: '#34e1ff', eyeGlow: 'rgba(52,225,255,0.55)', mouth: '#34e1ff', kind: 'robot' },
    human: { name: 'Alex', bg: ['#f3efe7', '#e6ded0'], head: '#f1c7a3', rim: '#d9a57f', hair: '#3b2a20', iris: '#4a6b8a', mouth: '#9c3d3d', brow: '#3b2a20', kind: 'human' },
  };

  function create({ character = 'robot', width = 1280, height = 720, fps = 30, name } = {}) {
    const look = { ...(CHARACTERS[character] || CHARACTERS.robot), ...(name ? { name } : {}) };
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    // Smoothed signals. Attack fast so the mouth opens on the syllable, release slower so it does not flicker.
    const s = { level: 0, low: 0.5, open: 0, round: 0.5, pushed: 0, listening: 0, blink: 0, nextBlink: 1.5, gaze: 0, gazeTo: 0, nextGaze: 2, t: 0 };
    let analyser = null, data = null, freq = null, audio = null;

    function attachAudio(track) {
      detachAudio();
      audio = new AudioContext();
      const source = audio.createMediaStreamSource(track instanceof MediaStream ? track : new MediaStream([track]));
      analyser = audio.createAnalyser();
      analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser); // never to destination: the face measures, it does not play
      data = new Float32Array(analyser.fftSize); freq = new Uint8Array(analyser.frequencyBinCount);
      audio.resume?.().catch(() => {});
    }
    function detachAudio() { try { audio?.close(); } catch {} audio = null; analyser = null; }

    // Speech level 0..1 and the share of energy below ~900 Hz (rounded vowels sit low, "ee" and "s" sit high).
    function measure() {
      if (!analyser) return { level: s.pushed, low: s.pushedLow ?? 0.5 };
      analyser.getFloatTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      analyser.getByteFrequencyData(freq);
      const hz = audio.sampleRate / analyser.fftSize, split = Math.round(900 / hz), top = Math.round(4000 / hz);
      let lo = 0, hi = 0;
      for (let i = 2; i < top && i < freq.length; i++) (i < split ? (lo += freq[i]) : (hi += freq[i]));
      return { level: clamp01((rms - 0.008) * 9), low: lo + hi > 0 ? lo / (lo + hi) : 0.5 };
    }

    function step(dt) {
      s.t += dt;
      const m = measure();
      s.level = lerp(s.level, m.level, m.level > s.level ? 0.55 : 0.18);
      s.low = lerp(s.low, m.low, 0.2);
      s.open = lerp(s.open, s.level, 0.5);
      s.round = lerp(s.round, clamp01((s.low - 0.35) * 2.2), 0.25);
      s.listening = lerp(s.listening, s.level > 0.05 ? 0 : s.pushedListening ? 1 : 0, 0.08);
      // Blink every 2.5-6 s, 130 ms closed; the eyes glance about every 1.5-4 s.
      s.nextBlink -= dt; if (s.nextBlink <= 0) { s.blink = 0.13; s.nextBlink = 2.5 + Math.random() * 3.5; }
      if (s.blink > 0) s.blink -= dt;
      s.nextGaze -= dt; if (s.nextGaze <= 0) { s.gazeTo = (Math.random() - 0.5) * 0.9; s.nextGaze = 1.5 + Math.random() * 2.5; }
      s.gaze = lerp(s.gaze, s.gazeTo, 0.08);
    }

    function background() {
      const g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, look.bg[0]); g.addColorStop(1, look.bg[1]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
    }

    function label() {
      ctx.font = `600 ${Math.round(height * 0.042)}px system-ui, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = look.kind === 'robot' ? 'rgba(255,255,255,0.85)' : 'rgba(40,30,20,0.8)';
      ctx.fillText(look.name, width * 0.035, height * 0.075); // top-left: Meet draws its own name tag bottom-left
    }

    function drawRobot(cx, cy, u) {
      const bob = Math.sin(s.t * 1.6) * u * 0.02 - s.open * u * 0.015;
      cy += bob;
      // antenna
      ctx.strokeStyle = look.rim; ctx.lineWidth = u * 0.03;
      ctx.beginPath(); ctx.moveTo(cx, cy - u * 0.62); ctx.lineTo(cx, cy - u * 0.8); ctx.stroke();
      ctx.fillStyle = look.eye; ctx.shadowColor = look.eyeGlow; ctx.shadowBlur = u * (0.08 + s.open * 0.25);
      ctx.beginPath(); ctx.arc(cx, cy - u * 0.84, u * 0.05, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      // head
      ctx.fillStyle = look.head; ctx.strokeStyle = look.rim; ctx.lineWidth = u * 0.025;
      ctx.beginPath(); ctx.roundRect(cx - u * 0.72, cy - u * 0.62, u * 1.44, u * 1.2, u * 0.28); ctx.fill(); ctx.stroke();
      // screen face
      ctx.fillStyle = '#0a1422';
      ctx.beginPath(); ctx.roundRect(cx - u * 0.58, cy - u * 0.46, u * 1.16, u * 0.88, u * 0.18); ctx.fill();
      // eyes: glowing, they squash on a blink and drift with the gaze
      const eyeY = cy - u * 0.12, gx = s.gaze * u * 0.08, blink = s.blink > 0 ? 0.12 : 1;
      ctx.fillStyle = look.eye; ctx.shadowColor = look.eyeGlow; ctx.shadowBlur = u * 0.12;
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(cx + side * u * 0.26 + gx, eyeY, u * 0.11, u * 0.13 * blink, 0, 0, TAU); ctx.fill();
      }
      // mouth: a glowing bar that opens with the speech and rounds on low vowels
      const mw = u * lerp(0.36, 0.22, s.round) * (1 + s.open * 0.25), mh = u * (0.035 + s.open * 0.2);
      ctx.beginPath(); ctx.roundRect(cx - mw / 2, cy + u * 0.2 - mh / 2, mw, mh, Math.min(mh, mw) / 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    function drawHuman(cx, cy, u) {
      const bob = Math.sin(s.t * 1.3) * u * 0.015 + s.listening * Math.sin(s.t * 3) * u * 0.01;
      cy += bob;
      // neck and shoulders
      ctx.fillStyle = '#5a6f8f';
      ctx.beginPath(); ctx.ellipse(cx, cy + u * 1.25, u * 1.05, u * 0.55, 0, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = look.head;
      ctx.fillRect(cx - u * 0.18, cy + u * 0.45, u * 0.36, u * 0.35);
      // hair behind, face, hair on top
      ctx.fillStyle = look.hair;
      ctx.beginPath(); ctx.ellipse(cx, cy - u * 0.12, u * 0.66, u * 0.74, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = look.head; ctx.strokeStyle = look.rim; ctx.lineWidth = u * 0.012;
      ctx.beginPath(); ctx.ellipse(cx, cy, u * 0.56, u * 0.66, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = look.hair;
      ctx.beginPath(); ctx.ellipse(cx - u * 0.05, cy - u * 0.5, u * 0.58, u * 0.26, -0.12, Math.PI * 0.98, TAU * 1.01); ctx.fill();
      // ears
      ctx.fillStyle = look.head;
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + side * u * 0.56, cy + u * 0.02, u * 0.07, u * 0.12, 0, 0, TAU); ctx.fill(); ctx.stroke(); }
      // brows lift a little when listening, and with emphasis
      const lift = s.listening * u * 0.03 + s.open * u * 0.025;
      ctx.strokeStyle = look.brow; ctx.lineWidth = u * 0.035; ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(cx + side * u * 0.13, cy - u * 0.25 - lift); ctx.lineTo(cx + side * u * 0.33, cy - u * 0.28 - lift * 0.6); ctx.stroke();
      }
      // eyes: whites, iris following the gaze, lids on a blink
      const eyeY = cy - u * 0.1, gx = s.gaze * u * 0.035, blink = s.blink > 0;
      for (const side of [-1, 1]) {
        const ex = cx + side * u * 0.22;
        if (blink) { ctx.strokeStyle = look.brow; ctx.lineWidth = u * 0.018; ctx.beginPath(); ctx.moveTo(ex - u * 0.08, eyeY); ctx.lineTo(ex + u * 0.08, eyeY); ctx.stroke(); continue; }
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(ex, eyeY, u * 0.09, u * 0.07, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = look.iris; ctx.beginPath(); ctx.arc(ex + gx, eyeY, u * 0.045, 0, TAU); ctx.fill();
        ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.arc(ex + gx, eyeY, u * 0.022, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(ex + gx + u * 0.012, eyeY - u * 0.014, u * 0.009, 0, TAU); ctx.fill();
      }
      // nose
      ctx.strokeStyle = look.rim; ctx.lineWidth = u * 0.016;
      ctx.beginPath(); ctx.moveTo(cx, cy - u * 0.02); ctx.quadraticCurveTo(cx + u * 0.05, cy + u * 0.1, cx - u * 0.02, cy + u * 0.12); ctx.stroke();
      // mouth: closed smile at rest; an open, rounded or widened mouth while speaking
      const my = cy + u * 0.3;
      if (s.open < 0.06) {
        ctx.strokeStyle = look.mouth; ctx.lineWidth = u * 0.022;
        ctx.beginPath(); ctx.arc(cx, my - u * 0.08, u * 0.14, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
      } else {
        const mw = u * lerp(0.26, 0.13, s.round), mh = u * (0.03 + s.open * 0.17);
        ctx.fillStyle = '#5a1f22'; ctx.beginPath(); ctx.ellipse(cx, my, mw / 2 + u * 0.01, mh / 2, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(cx, my - mh * 0.32, mw * 0.36, Math.max(u * 0.008, mh * 0.16), 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = look.mouth; ctx.lineWidth = u * 0.016; ctx.beginPath(); ctx.ellipse(cx, my, mw / 2 + u * 0.01, mh / 2, 0, 0, TAU); ctx.stroke();
      }
    }

    function draw() {
      background();
      const u = Math.min(width, height) * 0.44, cx = width / 2, cy = height * 0.5;
      (look.kind === 'human' ? drawHuman : drawRobot)(cx, cy, u);
      label();
    }

    let timer = null, last = performance.now();
    function tick() { const now = performance.now(); step(Math.min(0.1, (now - last) / 1000)); last = now; draw(); }
    function start() { if (!timer) { last = performance.now(); timer = setInterval(tick, 1000 / fps); tick(); } }
    function stop() { clearInterval(timer); timer = null; }
    const stream = canvas.captureStream(fps);
    start();
    return {
      canvas, stream, track: stream.getVideoTracks()[0],
      attachAudio, detachAudio,
      setLevel(level) { s.pushed = clamp01(Number(level) || 0); },       // for callers that already measure
      setBands(level, low) { s.pushed = clamp01(Number(level) || 0); s.pushedLow = clamp01(Number(low)); }, // level and low-band share
      advance(dt) { step(Math.min(0.1, Math.max(0, Number(dt) || 0))); draw(); }, // one deterministic frame, for offline rendering
      setListening(on) { s.pushedListening = Boolean(on); },             // the other person is talking
      state: () => ({ level: s.level, open: s.open, round: s.round, blinking: s.blink > 0 }),
      stop, start, frame: tick,                                          // frame(): draw once, for tests
    };
  }
  window.RoboMeetFace = { create, characters: Object.keys(CHARACTERS) };
})();
