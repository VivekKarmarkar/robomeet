/*
 * Puts the animated face (src/face.js) on the camera Meet sends, and moves its mouth with the voice Meet sends.
 *
 * Loaded after meet-media.js and meet-live.js, it stacks one more getUserMedia wrapper on top of theirs. When Meet
 * asks for media: video tracks are swapped for the face canvas track, and the first audio track, which is exactly the
 * voice this participant sends (the robot's GPT Live output in the single-hop path), is cloned into the face's
 * analyser. So the mouth only moves when the room can hear speech; muted, it stays shut. The listening state comes
 * from RoboMeetLive.health(): someone else audible, and this face not speaking. One job. close() puts the wrapped
 * function back, the same as the other layers.
 */
(() => {
  if (window.top !== window || window.RoboMeetFaceHook) return;
  const cfg = window.__robomeetFaceConfig || {};
  let face = null, tapped = false, swapped = 0;
  const ensureFace = () => {
    if (!face && window.RoboMeetFace) face = window.RoboMeetFace.create({ character: cfg.character || 'robot', name: cfg.name, width: 1280, height: 720, fps: 30 });
    return face;
  };
  const previous = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const wrapped = async constraints => {
    const stream = await previous(constraints);
    const f = ensureFace();
    if (!f) return stream;
    const voice = stream.getAudioTracks()[0];
    if (voice && !tapped) { try { f.attachAudio(voice.clone()); tapped = true; } catch {} }
    if (constraints?.video) {
      for (const track of stream.getVideoTracks()) { stream.removeTrack(track); track.stop(); }
      stream.addTrack(f.track.clone());
      swapped++;
    }
    return stream;
  };
  navigator.mediaDevices.getUserMedia = wrapped;
  const listening = setInterval(() => {
    const health = window.RoboMeetLive?.health?.();
    if (!face || !health) return;
    face.setListening(Boolean(health.lastInputAudibleAt) && Date.now() - health.lastInputAudibleAt < 600);
  }, 150);
  window.RoboMeetFaceHook = {
    health: () => ({ tapped, swapped, character: cfg.character || 'robot', face: face?.state?.() || null }),
    close() {
      clearInterval(listening);
      try { face?.stop(); face?.detachAudio(); } catch {}
      if (navigator.mediaDevices.getUserMedia === wrapped) navigator.mediaDevices.getUserMedia = previous;
    },
  };
})();
