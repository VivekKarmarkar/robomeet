import {request,command} from './api.js';

export class LiveVoice {
  // Playout target for audio arriving from GPT Live (ms). Chrome's default adapts to ~300 ms even on a stable link; a short target trims that from every reply.
  static JITTER_TARGET_MS=Number(new URLSearchParams(location.search).get('jitter')??40);
  constructor(media,{preview=false,onStatus=()=>{},onTranscript=()=>{}}={}){this.media=media;this.preview=preview;this.onStatus=onStatus;this.onTranscript=onTranscript;this.generation=0;this.sessionId=null;this.connection=null;this.dataChannel=null;this.starting=false;this.status='idle';}
  statusChanged(status,error){this.status=status;this.media.setVoiceStatus(status);this.onStatus(status,error);command('voice-status',{status,...(error?{error}: {})}).catch(()=>{});}
  async start(prompt=''){
    if(this.starting||this.connection||this.stopping)return;this.starting=true;const generation=++this.generation;this.media.setSessionMuted(false);this.statusChanged('connecting');
    try{
      await this.media.resume();if(this.preview)await this.media.useLocalMicrophone();
      if(generation!==this.generation)return;
      if(!this.preview&&!this.media.meetingInput?.getAudioTracks().length)throw new Error('Meeting audio is not connected yet. Stop voice, wait for admission, then start again.');
      const pc=new RTCPeerConnection();this.connection=pc;pc.addTrack(this.media.inputDestination.stream.getAudioTracks()[0],this.media.inputDestination.stream);
      pc.ontrack=event=>{if(generation!==this.generation)return;try{event.receiver.jitterBufferTarget=LiveVoice.JITTER_TARGET_MS;}catch{}this.media.setVoiceOutput(event.streams[0]||new MediaStream([event.track]));};
      pc.onconnectionstatechange=()=>{if(generation!==this.generation)return;if(pc.connectionState==='failed')this.fail('Voice connection failed. Stop and restart voice.');};
      const channel=pc.createDataChannel('oai-events');this.dataChannel=channel;
      channel.onmessage=event=>{let data;try{data=JSON.parse(event.data);}catch{return;}if(generation!==this.generation)return;
        if(data.type==='session.started')this.statusChanged('active');
        if(data.type==='error')this.fail(data.error?.message||data.message||'The voice service reported an error.');
        if(data.type==='session.input_transcript.delta'||data.type==='session.output_transcript.delta')this.onTranscript({role:data.type.includes('input_')?'user':'assistant',text:data.delta||'',start_ms:data.start_ms,end_ms:data.end_ms});
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(resolve=>{if(pc.iceGatheringState==='complete')return resolve();const timeout=setTimeout(done,1500);function done(){clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',check);resolve();}function check(){if(pc.iceGatheringState==='complete')done();}pc.addEventListener('icegatheringstatechange',check);});
      if(generation!==this.generation)return;
      this.creation=request('/api/live/sessions',{sdp:pc.localDescription.sdp,prompt});
      const result=await this.creation;
      this.creation=null;
      if(generation!==this.generation){await request(`/api/live/sessions/${encodeURIComponent(result.id)}`,undefined,'DELETE').catch(()=>{});return;}
      this.sessionId=result.id;await pc.setRemoteDescription({type:'answer',sdp:result.sdp});
      const heartbeat=()=>request(`/api/live/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`,{}).catch(error=>{if(generation===this.generation)this.fail(error.message);});
      this.heartbeat=setInterval(heartbeat,5000);await heartbeat();
      this.startTimeout=setTimeout(()=>{if(generation===this.generation&&this.status!=='active')this.fail('Voice did not become ready. Stop and restart voice.');},25000);
    }catch(error){if(generation===this.generation)await this.fail(error.message);}finally{if(generation===this.generation)this.starting=false;}
  }
  async fail(message){await this.stop({report:false});this.statusChanged('error',message);}
  stop({report=true}={}){
    if(this.stopping)return this.stopping;
    ++this.generation;this.starting=false;this.status='closing';clearInterval(this.heartbeat);clearTimeout(this.startTimeout);this.media.setSessionMuted(true);
    this.stopping=(async()=>{
      let id=this.sessionId;
      if(!id&&this.creation){const created=await this.creation.catch(()=>null);id=created?.id;}
      this.creation=null;
      // Keep media and the event channel alive until the server has received
      // session.closed, or its bounded close timeout has expired.
      if(id)await request(`/api/live/sessions/${encodeURIComponent(id)}`,undefined,'DELETE').catch(()=>{});
      this.sessionId=null;this.dataChannel?.close();this.dataChannel=null;this.connection?.close();this.connection=null;
      this.media.clearVoiceOutput();this.media.releaseLocalMicrophone();if(report)this.statusChanged('idle');else this.status='idle';
    })().finally(()=>{this.stopping=null;});
    return this.stopping;
  }
  dispose(){const id=this.sessionId;this.media.setSessionMuted(true);this.stop({report:false});if(id){fetch(`/api/live/sessions/${encodeURIComponent(id)}`,{method:'DELETE',keepalive:true,credentials:'same-origin'}).catch(()=>{});}}
}
