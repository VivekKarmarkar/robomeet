const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
function round(ctx,x,y,w,h,r,fill){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();}
function wrap(ctx,text,maxWidth){const lines=[];for(const paragraph of String(text||'').split('\n')){let line='';for(const word of paragraph.split(/\s+/)){const next=line?`${line} ${word}`:word;if(line&&ctx.measureText(next).width>maxWidth){lines.push(line);line=word;}else line=next;}lines.push(line);}return lines;}

export class StudioMedia {
  constructor(camera,screen,{renderer=false,preview=false,devtest=false}={}){
    this.camera= camera;this.screen=screen;this.renderer=renderer;this.preview=preview;this.devtest=devtest;
    this.mode='listen';this.voiceStatus='idle';this.slides=[];this.slideIndex=0;this.title='';this.level=0;this.lastPaint=0;
    this.audioContext=new AudioContext({latencyHint:'interactive'});
    this.outputGain=this.audioContext.createGain();this.outputGain.gain.value=0;
    this.outputDestination=this.audioContext.createMediaStreamDestination();this.outputGain.connect(this.outputDestination);
    this.analyser=this.audioContext.createAnalyser();this.analyser.fftSize=256;this.outputGain.connect(this.analyser);this.wave=new Float32Array(256);
    this.inputGain=this.audioContext.createGain();this.inputGain.gain.value=1;this.inputDestination=this.audioContext.createMediaStreamDestination();this.inputGain.connect(this.inputDestination);
    // Silent keep-alive into both outgoing destinations: a destination with no connected input sends no packets, and the far
    // side's jitter buffer then inflates (measured ~1 s) until the first replies have flowed.
    for(const destination of [this.outputDestination,this.inputDestination]){const keep=this.audioContext.createConstantSource();keep.offset.value=0;keep.connect(destination);keep.start();}
    this.monitorGain=this.audioContext.createGain();this.monitorGain.gain.value=preview?1:0;this.outputGain.connect(this.monitorGain);this.monitorGain.connect(this.audioContext.destination);
    this.paintRobot(0);this.paintSlides();
    this.cameraStream=camera.captureStream(24);this.screenStream=screen.captureStream(12);
    this.tracks={audio:this.outputDestination.stream.getAudioTracks()[0],camera:this.cameraStream.getVideoTracks()[0],screen:this.screenStream.getVideoTracks()[0]};
    this.ready=Promise.resolve(this.tracks);this.tick=this.tick.bind(this);this.frame=requestAnimationFrame(this.tick);
  }
  getOutgoingTracks(){return this.tracks;}
  async resume(){await this.audioContext.resume();if(this.audioContext.state!=='running')throw new Error('Audio is paused by the browser. Restart the meeting renderer with audio playback allowed.');}
  anchorStream(key,stream){this[key]?.pause();if(this[key]){this[key].srcObject=null;this[key].remove();this[key]=null;}if(!stream?.getAudioTracks().length)return;const audio=document.createElement('audio');audio.muted=true;audio.autoplay=true;audio.hidden=true;audio.setAttribute('playsinline','');audio.setAttribute('aria-hidden','true');audio.srcObject=stream;document.body.append(audio);this[key]=audio;audio.play().catch(()=>{});}
  setMeetingInput(stream){if(!(stream instanceof MediaStream))throw new TypeError('Meeting input must be a MediaStream.');this.inputSource?.disconnect();this.meetingInput=stream;this.anchorStream('inputAnchor',stream);this.inputSource=stream.getAudioTracks().length?this.audioContext.createMediaStreamSource(stream):null;this.inputSource?.connect(this.inputGain);}
  async useLocalMicrophone(){if(!this.preview)throw new Error('Local microphone is available only in explicit preview mode.');if(!this.localMicrophone){this.localMicrophone=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});this.setMeetingInput(this.localMicrophone);}return this.localMicrophone;}
  releaseLocalMicrophone(){if(this.localMicrophone){this.inputSource?.disconnect();this.inputSource=null;this.anchorStream('inputAnchor',null);this.localMicrophone.getTracks().forEach(track=>track.stop());this.localMicrophone=null;this.meetingInput=null;}}
  setVoiceOutput(stream){this.remoteSource?.disconnect();this.remoteStream=stream;this.anchorStream('outputAnchor',stream);this.remoteSource=stream?.getAudioTracks().length?this.audioContext.createMediaStreamSource(stream):null;this.remoteSource?.connect(this.outputGain);}
  clearVoiceOutput(){this.remoteSource?.disconnect();this.remoteSource=null;this.remoteStream=null;this.anchorStream('outputAnchor',null);this.level=0;}
  setMode(mode){if(!['quiet','listen','speak'].includes(mode))return;this.mode=mode;this.updateGains();}
  setSessionMuted(muted){this.sessionMuted=muted;this.updateGains();}
  updateGains(){this.outputGain.gain.setValueAtTime(!this.sessionMuted&&this.mode==='speak'?1:0,this.audioContext.currentTime);this.inputGain.gain.setValueAtTime(this.sessionMuted||this.mode==='quiet'?0:1,this.audioContext.currentTime);}
  setVoiceStatus(status){this.voiceStatus=status;}
  setPresentation(slides=[],index=0,title=''){this.slides=Array.isArray(slides)?slides:[];this.slideIndex=clamp(Number(index)||0,0,Math.max(0,this.slides.length-1));this.title=String(title||'');this.paintSlides();}
  tick(time){if(time-this.lastPaint>40){this.lastPaint=time;this.analyser.getFloatTimeDomainData(this.wave);let sum=0;for(const x of this.wave)sum+=x*x;const rms=Math.sqrt(sum/this.wave.length);this.level=this.level*.63+clamp(rms*8,0,1)*.37;this.paintRobot(time);}
    // The slide canvas must be redrawn continuously: a canvas capture stream only emits frames when the canvas changes, and
    // a single frame at deck time never reached Meet (Meet-side screenFrames stayed 0 in the 2026-09-14 live test).
    if(time-(this.lastSlidePaint||0)>200){this.lastSlidePaint=time;this.paintSlides();}
    this.frame=requestAnimationFrame(this.tick);}
  paintRobot(time){const ctx=this.camera.getContext('2d');const w=this.camera.width,h=this.camera.height;ctx.clearRect(0,0,w,h);const bg=ctx.createRadialGradient(w*.5,h*.38,60,w*.5,h*.5,750);bg.addColorStop(0,'#354d3d');bg.addColorStop(1,'#182820');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#d0e9c80a';ctx.lineWidth=1;for(let x=0;x<w;x+=48){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=48){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    const bob=Math.sin(time*.0018)*5;ctx.save();ctx.translate(w/2,h/2+bob-20);ctx.fillStyle='#07140d45';ctx.beginPath();ctx.ellipse(0,246-bob,185,21,0,0,Math.PI*2);ctx.fill();
    // A rounded little robot with an antenna, soft shell, and expressive eyes.
    ctx.strokeStyle='#b3c6a8';ctx.lineWidth=10;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(0,-164);ctx.lineTo(0,-209);ctx.stroke();ctx.fillStyle=this.voiceStatus==='active'?'#c7f5ac':'#9eae8c';ctx.beginPath();ctx.arc(0,-215,13,0,Math.PI*2);ctx.fill();
    round(ctx,-155,76,310,143,53,'#becbaa');round(ctx,-119,103,238,87,34,'#d8dfbf');round(ctx,-189,101,39,88,19,'#c7d4b2');round(ctx,150,101,39,88,19,'#c7d4b2');round(ctx,-98,208,66,25,11,'#92a485');round(ctx,32,208,66,25,11,'#92a485');
    round(ctx,-228,-66,42,102,17,'#a4b997');round(ctx,186,-66,42,102,17,'#a4b997');round(ctx,-200,-166,400,267,76,'#d8e2c4');round(ctx,-176,-142,352,217,60,'#a5b59b');round(ctx,-168,-135,336,204,56,'#172920');
    const blink=Math.sin(time*.00075)> .992;const eyeH=blink?6:36;const eyeY=-54+(blink?15:0);const energy=this.level;ctx.shadowBlur=18;ctx.shadowColor='#d0ffac66';round(ctx,-100,eyeY,56,eyeH,18,'#cdf5ad');round(ctx,44,eyeY,56,eyeH,18,'#cdf5ad');ctx.shadowBlur=0;
    ctx.strokeStyle='#cef5ae';ctx.lineWidth=6;ctx.beginPath();if(energy>.035){for(let x=-37;x<=37;x+=3){const y=26+Math.sin(x*.16+time*.018)*energy*19; x===-37?ctx.moveTo(x,y):ctx.lineTo(x,y);}}else{ctx.moveTo(-29,21);ctx.quadraticCurveTo(0,40,29,21);}ctx.stroke();ctx.fillStyle='#8fa986';ctx.beginPath();ctx.arc(-121,12,12,0,Math.PI*2);ctx.arc(121,12,12,0,Math.PI*2);ctx.fill();
    round(ctx,-30,125,60,13,6,'#91a27f');ctx.fillStyle=energy>.035?'#42633f':'#698761';ctx.beginPath();ctx.arc(0,160,6+energy*4,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.font='500 14px system-ui';ctx.fillStyle='#a8bea9';ctx.textAlign='center';const caption=this.voiceStatus==='active'?(energy>.035?'Speaking':this.mode==='quiet'?'Quiet':this.mode==='listen'?'Listening · output muted':'Listening'):this.voiceStatus==='connecting'?'Connecting voice…':'Ready when you are';ctx.fillText(caption,w/2,h-67);ctx.textAlign='left';
  }
  // A slide whose body is "image:<path under /public>" is drawn as a picture that fills the shared screen (the deck
  // canvas is otherwise text only). The image is fetched once per path and cached.
  slideImage(path){this.images??=new Map();let entry=this.images.get(path);if(!entry){const img=new Image();entry={img,ready:false,failed:false};img.onload=()=>{entry.ready=true;};img.onerror=()=>{entry.failed=true;};img.src=path;this.images.set(path,entry);}return entry;}
  paintSlides(){const ctx=this.screen.getContext('2d'),w=this.screen.width,h=this.screen.height;const current=this.slides[this.slideIndex];const body0=typeof current?.body==='string'?current.body.trim():'';
    if(body0.startsWith('image:')){const entry=this.slideImage(body0.slice(6).trim());ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);if(entry.ready){const r=Math.min(w/entry.img.width,h/entry.img.height),dw=entry.img.width*r,dh=entry.img.height*r;ctx.drawImage(entry.img,(w-dw)/2,(h-dh)/2,dw,dh);}else{ctx.fillStyle='#2e4232';ctx.font='500 40px system-ui';ctx.textAlign='center';ctx.fillText(entry.failed?'Picture could not be loaded.':String(current.title||''),w/2,h/2);ctx.textAlign='left';}return;}
    ctx.fillStyle='#eee7cf';ctx.fillRect(0,0,w,h);ctx.fillStyle='#d8d1b5';ctx.fillRect(68,73,31,7);ctx.font='600 16px system-ui';ctx.fillStyle='#61705c';ctx.fillText((this.title||'ROBOMEET · PRESENTATION').slice(0,85).toUpperCase(),114,86);
    const slide=this.slides[this.slideIndex];if(!slide){ctx.font='500 64px system-ui';ctx.fillStyle='#2e4232';ctx.fillText('Room for an idea.',70,310);ctx.font='24px system-ui';ctx.fillStyle='#73816c';ctx.fillText('Add a deck, then share it with the room.',74,360);ctx.strokeStyle='#879b7540';ctx.lineWidth=2;ctx.beginPath();ctx.arc(1080,445,180,0,Math.PI*2);ctx.arc(1110,425,125,0,Math.PI*2);ctx.stroke();return;}
    const title=String(slide.title||'Untitled slide');ctx.fillStyle='#263e2d';ctx.font='600 62px system-ui';const titleLines=wrap(ctx,title,1100).slice(0,3);let y=204;for(const line of titleLines){ctx.fillText(line,74,y);y+=77;}y+=27;ctx.font='28px system-ui';ctx.fillStyle='#4d5e48';const body=Array.isArray(slide.body)?slide.body.map(x=>`• ${x}`).join('\n'):String(slide.body||slide.text||'');for(const line of wrap(ctx,body,1100).slice(0,Math.floor((620-y)/43))){ctx.fillText(line,78,y);y+=43;}ctx.fillStyle='#8b967d';ctx.fillRect(74,652,1132,1);ctx.font='16px system-ui';ctx.fillText('RoboMeet',75,683);ctx.textAlign='right';ctx.fillText(`${this.slideIndex+1} / ${this.slides.length}`,1204,683);ctx.textAlign='left';
  }
  async testTone({frequency=440,durationMs=1000}={}){if(!this.devtest)throw new Error('Test media requires ?devtest=1.');await this.resume();const oscillator=this.audioContext.createOscillator(),gain=this.audioContext.createGain();oscillator.frequency.value=frequency;gain.gain.value=.08;oscillator.connect(gain);gain.connect(this.outputGain);oscillator.start();oscillator.stop(this.audioContext.currentTime+clamp(durationMs,50,10000)/1000);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}
  dispose(){cancelAnimationFrame(this.frame);this.releaseLocalMicrophone();this.anchorStream('inputAnchor',null);this.anchorStream('outputAnchor',null);Object.values(this.tracks).forEach(track=>track.stop());this.audioContext.close().catch(()=>{});}
}
