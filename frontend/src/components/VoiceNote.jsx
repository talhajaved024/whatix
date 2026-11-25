import {useEffect,useRef,useState} from 'react';
import Icon from './Icon.jsx';

const clock=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');

export function VoiceRecorder({disabled,onDraft,onError}){
  const active=useRef(null);
  const [phase,setPhase]=useState('idle');
  const [seconds,setSeconds]=useState(0);
  function release(job){
    if(!job)return;
    clearInterval(job.timer);
    if(job.recorder && job.recorder.state!=='inactive')job.recorder.stop();
    job.stream?.getTracks().forEach(track=>track.stop());
  }
  function discard(){
    const job=active.current;
    active.current=null;
    release(job);
    setPhase('idle');
  }
  useEffect(()=>{
    window.addEventListener('pagehide',discard);
    return ()=>{window.removeEventListener('pagehide',discard);const job=active.current;active.current=null;release(job);};
  },[]);
  async function start(){
    if(active.current)return;
    const job={};active.current=job;setPhase('opening');
    try{
      if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)throw new Error('Voice recording requires a supported browser on HTTPS or localhost.');
      job.stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(active.current!==job){release(job);return;}
      const mime=['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
      const recorder=new MediaRecorder(job.stream,mime?{mimeType:mime}:undefined);
      const chunks=[];job.recorder=recorder;
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>{if(active.current===job){discard();onError('Recording failed. Check your microphone and try again.');}};
      recorder.onstop=()=>{
        if(active.current!==job)return;
        active.current=null;release(job);setPhase('idle');
        const type=recorder.mimeType || chunks[0]?.type;
        if(!chunks.length || !type){onError('No audio was recorded. Try again.');return;}
        const ext=type.includes('ogg')?'ogg':type.includes('mp4')?'m4a':'webm';
        onDraft(new File(chunks,'voice-note.'+ext,{type}),(performance.now()-began)/1000);
      };
      recorder.start(1000);
      const began=performance.now();
      setSeconds(0);setPhase('recording');
      job.timer=setInterval(()=>setSeconds((performance.now()-began)/1000),250);
    }catch(err){
      if(active.current!==job)return;
      discard();onError(err.name==='NotAllowedError'?'Microphone access was denied. Allow it to record a voice note.':err.message);
    }
  }
  if(phase==='idle')return <button type="button" className="send" disabled={disabled} aria-label="Record voice note" title="Record voice note" onClick={start}><Icon name="mic"/></button>;
  return <div className="voice-record"><button type="button" onClick={discard}>Discard</button>
    <span role="status">{phase==='opening'?'Opening microphone…':'● '+clock(seconds)}</span>
    <button type="button" disabled={phase!=='recording'} onClick={()=>{setPhase('finishing');active.current.recorder.stop();}}>Stop</button></div>;
}

export function VoicePlayer({src,onError,recordedDuration=0}){
  const audio=useRef(null);
  const [playing,setPlaying]=useState(false),[elapsed,setElapsed]=useState(0),[duration,setDuration]=useState(recordedDuration),[speed,setSpeed]=useState(1);
  return <div className="voice-player">
    <audio ref={audio} src={src} preload="metadata" onError={onError}
      onDurationChange={e=>setDuration(Number.isFinite(e.target.duration)?e.target.duration:recordedDuration)}
      onTimeUpdate={e=>setElapsed(e.target.currentTime)} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}
      onEnded={()=>{setPlaying(false);setElapsed(0);}}/>
    <button type="button" className="voice-toggle" aria-label={playing?'Pause voice note':'Play voice note'} onClick={()=>playing?audio.current.pause():audio.current.play().catch(onError)}>{playing?'Ⅱ':'▶'}</button>
    <div><input type="range" aria-label="Seek voice note" min="0" max={duration||1} step="0.1" value={Math.min(elapsed,duration)} disabled={!duration} onChange={e=>{audio.current.currentTime=Number(e.target.value);setElapsed(Number(e.target.value));}}/>
      <small>{clock(elapsed)} / {clock(duration)}</small></div>
    <button type="button" aria-label={'Playback speed '+speed+' times'} onClick={()=>{const next=speed===1?1.5:speed===1.5?2:1;audio.current.playbackRate=next;setSpeed(next);}}>{speed}×</button>
  </div>;
}
