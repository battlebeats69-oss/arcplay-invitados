/* ArcPlay guest v1.1: full keyboard + mouse over low-latency WebRTC channels. */
'use strict';
const $ = selector => document.querySelector(selector);
const pressed = new Set();
const mouseButtons = ArcInput.buttons;
let sessionIce=ArcIce.DEFAULTS;
const myId = crypto.randomUUID();
let bus=null, pc=null, control=null, movement=null, hostId='';
let connected=false, playing=false, videoReady=false, mouseMask=0;
let connecting=false, joining=false, offerPending=false, lastOfferAt=0;
let pendingIce=[], helloTimer=null, safetyTimer=null, pingTimer=null, errorTimer=null;
let motionTimer=null, motionRecoveryTimer=null, motionRepeats=0, pendingMotion=false, motionSeq=0, totalMX=0, totalMY=0, lastMotionAt=0;
let channelConnected=false, peerConnected=false, currentCode='';
let roomServiceReady=false, hostFound=false, offerReceived=false, lastIceState='new';
let soundEnabled=false, latencyTimer=null;
const video=$('#video');
const videoBox=$('#video-box');

function topStatus(text,on=false){$('#top-status').textContent=text;$('#dot').classList.toggle('on',on);}
function setConnection(title,description,failed=false){
  const layer=$('#connection-screen');
  layer.hidden=false;layer.classList.toggle('error',failed);
  $('#connection-eyebrow').textContent=failed?'NO SE PUDO CONECTAR':'INVITACIÓN RECIBIDA';
  $('#connection-title').textContent=title;
  $('#connection-description').textContent=description;
  $('#connection-actions').hidden=!failed;
  layer.setAttribute('role',failed?'alert':'status');
}
function dismissConnection(){const layer=$('#connection-screen');layer.hidden=true;layer.classList.remove('error');}
function failConnection(title,description){
  clearTimeout(errorTimer);errorTimer=null;
  connected=false;channelConnected=false;peerConnected=false;
  stopControls();document.body.classList.remove('is-playing');
  setConnection(title,description,true);topStatus('Sin conexión');
}
function armTimeout(){
  clearTimeout(errorTimer);
  errorTimer=setTimeout(()=>{
    if(connected)return;
    if(!roomServiceReady)failConnection('Servicio de conexión inaccesible','No hemos podido abrir la sala. Comprueba la conexión a Internet y prueba con otra red.');
    else if(!hostFound&&!offerReceived)failConnection('No encontramos la partida','Confirma que el anfitrión sigue compartiendo, que el enlace no ha caducado y que ambos usáis ArcPlay actualizado.');
    else if(!peerConnected)failConnection('Las redes no consiguen comunicarse','Encontramos la partida, pero no se abrió el canal WebRTC. Prueba otra red o pide al anfitrión activar la compatibilidad de conexión. (NET-ICE)');
    else failConnection('No llega el vídeo o los controles','Se localizó el anfitrión, pero faltan datos de la partida. Recarga la pestaña del juego y vuelve a intentarlo.');
  },30000);
}
function maybeReady(){
  if(connected||!channelConnected||!videoReady||!peerConnected||control?.readyState!=='open')return;
  connected=true;clearTimeout(errorTimer);errorTimer=null;
  dismissConnection();
  document.body.classList.add('is-playing');
  $('#toggle').disabled=false;
  $('#toggle-label').textContent='Activar controles';
  topStatus('Conectado',true);
  video.play().catch(()=>{});
}
// WebRTC playback latency: a best-effort hint, not a guaranteed delay.
// React to network jitter instead of forcing an unrealistically tiny buffer.
function setPlaybackBuffer(conn, ms){
  for(const receiver of conn.getReceivers()){
    try{
      if('jitterBufferTarget' in receiver)receiver.jitterBufferTarget=ms;
      else if('playoutDelayHint' in receiver)receiver.playoutDelayHint=ms/1000;
    }catch{} // Unsupported/disabled on some browsers.
  }
}
async function tunePlaybackBuffer(conn){
  if(pc!==conn||conn.connectionState!=='connected')return;
  try{
    const stats=await conn.getStats();
    let maxJitter=0;
    for(const r of stats.values()){
      if(r.type==='inbound-rtp'&&(r.kind==='video'||r.kind==='audio')&&Number.isFinite(r.jitter))
        maxJitter=Math.max(maxJitter,r.jitter);
    }
    const targetMs=maxJitter>.035?100:maxJitter>.018?65:35;
    setPlaybackBuffer(conn,targetMs);
  }catch{}
}
function sendControl(obj){
  if(control?.readyState!=='open'||control.bufferedAmount>10000)return;
  try{control.send(JSON.stringify(obj));}catch{}
}
function snapshot(){sendControl({t:'snapshot',k:[...pressed],b:mouseMask});}
function sendEdge(kind,value,down){
  if(kind==='key')sendControl({t:'edge',kind,code:value,down});
  else {sendControl({t:'edge',kind,button:value,down,x:cursorPosition.x,y:cursorPosition.y,locked:!!document.pointerLockElement});}
}
function resetInputs(){
  for(const code of pressed)sendEdge('key',code,false);
  for(const [name,bit] of Object.entries(mouseButtons))if(mouseMask&bit)sendEdge('button',name,false);
  pressed.clear();mouseMask=0;snapshot();
}
function stopControls(){
  if(motionRecoveryTimer!==null){clearTimeout(motionRecoveryTimer);motionRecoveryTimer=null;}
  if(motionTimer!==null){clearTimeout(motionTimer);motionTimer=null;}
  pendingMotion=false;motionRepeats=0;
  sendControl({t:'pointer-mode',locked:false});
  sendControl({t:'input-active',on:false});
  resetInputs();playing=false;
  if(document.pointerLockElement)document.exitPointerLock();
  document.body.classList.remove('pointer-locked');
  $('#toggle').classList.remove('playing');
  $('#toggle-label').textContent=connected?'Activar controles':'Esperando conexión';
  $('#lock-mouse').disabled=true;
  $('#lock-mouse').textContent='Capturar ratón';
}
function setControls(on){
  if(!connected)return;
  if(!on){stopControls();return;}
  motionSeq=0;totalMX=0;totalMY=0;lastMotionAt=0;
  playing=true;sendControl({t:'input-active',on:true});sendControl({t:'pointer-mode',locked:!!document.pointerLockElement});snapshot();$('#toggle').classList.add('playing');$('#toggle-label').textContent='Desactivar controles';
  $('#lock-mouse').disabled=false;
  $('#keyboard-focus').focus({preventScroll:true});
  video.play().catch(()=>{});
}
function clearTimers(){
  for(const t of [safetyTimer,pingTimer,helloTimer,motionTimer,motionRecoveryTimer,errorTimer])clearTimeout(t);
  safetyTimer=pingTimer=helloTimer=motionTimer=motionRecoveryTimer=errorTimer=null;
}
function closePeer(){
  if(latencyTimer!==null){clearInterval(latencyTimer);latencyTimer=null;}
  stopControls();
  clearInterval(safetyTimer);clearInterval(pingTimer);safetyTimer=pingTimer=null;
  for(const ch of [control,movement])try{ch?.close();}catch{}
  control=movement=null;
  if(pc)try{pc.close();}catch{}pc=null;
  video.srcObject=null;video.classList.remove('ready');
  videoReady=false;channelConnected=false;peerConnected=false;connected=false;
  $('#ping').textContent='— ms';
  $('#toggle').disabled=true;
  document.body.classList.remove('is-playing');
}
function signal(data){if(bus)void bus.send({...data,from:myId,to:hostId}).catch(()=>{});}
function onVideoFrame(){
  if(video.readyState>=2){videoReady=true;video.classList.add('ready');$('#waiting').hidden=true;maybeReady();}
}
video.addEventListener('loadeddata',onVideoFrame);
video.addEventListener('playing',onVideoFrame);

async function openPeer(){
  const earlyCandidates=pendingIce;
  closePeer();pendingIce=earlyCandidates;
  const conn=new RTCPeerConnection({iceServers:sessionIce,bundlePolicy:'max-bundle'});pc=conn;
  const media=new MediaStream();
  conn.ontrack=e=>{
    if(pc!==conn)return;
    if(!media.getTracks().includes(e.track))media.addTrack(e.track);
    if(e.receiver){
      try{
        if('jitterBufferTarget' in e.receiver)e.receiver.jitterBufferTarget=35;
        else if('playoutDelayHint' in e.receiver)e.receiver.playoutDelayHint=.035;
      }catch{}
    }
    video.srcObject=media;
    video.play().catch(()=>{});
  };
  conn.ondatachannel=e=>{
    if(pc!==conn)return;
    const ch=e.channel;
    if(ch.label==='arcplay-control'){
      control=ch;
      ch.onopen=()=>{
        if(pc!==conn)return;
        channelConnected=true;
        safetyTimer=setInterval(()=>{if(playing)snapshot();},110);
        pingTimer=setInterval(()=>{if(ch.readyState==='open'&&ch.bufferedAmount<10000)sendControl({t:'ping',n:performance.now()});},950);
        maybeReady();
      };
      ch.onclose=()=>{
        if(pc!==conn)return;
        channelConnected=false;connected=false;stopControls();
        if(conn.connectionState!=='failed'){setConnection('Reconectando a la partida...','Recuperando vídeo y controles.');armTimeout();}
      };
      ch.onmessage=evt=>{try{
        const msg=JSON.parse(evt.data);
        if(msg.t==='pong'&&typeof msg.n==='number'&&Number.isFinite(msg.n))$('#ping').textContent=Math.round(performance.now()-msg.n)+' ms';
      }catch{}};
    }else if(ch.label==='arcplay-move')movement=ch;
  };
  conn.onicecandidate=e=>{if(e.candidate&&pc===conn)signal({t:'candidate',candidate:e.candidate.toJSON()});};
  conn.oniceconnectionstatechange=()=>{if(pc===conn)lastIceState=conn.iceConnectionState;};
  conn.onconnectionstatechange=()=>{
    if(pc!==conn)return;
    if(conn.connectionState==='connected'){peerConnected=true;maybeReady();setPlaybackBuffer(conn,35);
      if(latencyTimer!==null)clearInterval(latencyTimer);
      latencyTimer=setInterval(()=>void tunePlaybackBuffer(conn),3000);
    }
    else if(conn.connectionState==='disconnected'){
      if(latencyTimer!==null){clearInterval(latencyTimer);latencyTimer=null;}
      peerConnected=false;connected=false;stopControls();document.body.classList.remove('is-playing');
      setConnection('Reconectando a la partida...','La conexión se ha interrumpido.');armTimeout();
    }else if(conn.connectionState==='failed'){
      if(latencyTimer!==null){clearInterval(latencyTimer);latencyTimer=null;}
      failConnection('Conexión de red bloqueada','La invitación funciona, pero no hay una ruta de vídeo entre vuestras redes. Prueba datos móviles o el modo de compatibilidad del anfitrión. (NET-ICE)');
    }
  };
}
async function onSignal(msg){
  if(msg.to&&msg.to!==myId)return;
  if(msg.t==='present'){
    hostFound=true;
    if(!offerReceived&&!connected)setConnection('Anfitrión encontrado','Estableciendo conexión entre los dos navegadores.');
    return;
  }
  if(msg.t==='offer'){
    if(!msg.description||msg.description.type!=='offer'||typeof msg.from!=='string')return;
    if(offerPending||(pc&&pc.connectionState==='connected'&&connected))return;
    if(pc&&pc.signalingState==='have-remote-offer'&&Date.now()-lastOfferAt<4000)return;
    offerPending=true;hostFound=true;offerReceived=true;hostId=msg.from;lastOfferAt=Date.now();
    sessionIce=ArcIce.merge(msg.network);
    try{
      setConnection('Conectando a la partida...','Sincronizando vídeo y controles.');
      await openPeer();
      await pc.setRemoteDescription(msg.description);
      await pc.setLocalDescription(await pc.createAnswer());
      signal({t:'answer',description:pc.localDescription});
      for(const candidate of pendingIce)try{await pc.addIceCandidate(candidate);}catch{}
      pendingIce=[];
    }finally{offerPending=false;}
  }else if(msg.t==='candidate'&&msg.candidate){
    if(hostId&&msg.from!==hostId)return;
    if(pc?.remoteDescription)try{await pc.addIceCandidate(msg.candidate);}catch{}
    else if(pendingIce.length<100)pendingIce.push(msg.candidate);
  }else if(msg.t==='bye'&&msg.from===hostId){
    closePeer();failConnection('La partida ha terminado','El anfitrión ha finalizado la sesión.');
  }
}
function sayHello(){if(bus&&!connected)void bus.send({t:'hello',from:myId,v:8}).catch(()=>{});}
async function join(){
  if(joining)return;
  let code;
  try{code=ArcSignal.parseCode($('#room-code').value).code;}
  catch(e){$('#join-error').textContent=e.message;failConnection('Invitación no válida',e.message);return;}
  joining=true;currentCode=code;$('#join-error').textContent='';$('#join-game').disabled=true;
  try{
    clearTimers();bus?.close();bus=null;
    closePeer();hostId='';pendingIce=[];roomServiceReady=false;hostFound=false;offerReceived=false;lastIceState='new';sessionIce=ArcIce.DEFAULTS;
    setConnection('Conectando a la partida...','Buscando a tu amigo y preparando la transmisión.');
    topStatus('Conectando');armTimeout();
    bus=await ArcSignal.SignalBus.connect(code,'guest',message=>{
      void onSignal(message).catch(()=>failConnection('Error de conexión','No se ha podido completar la conexión. Pulsa Reintentar.'));
    },ready=>{roomServiceReady=ready;if(ready&&!connected){sayHello();topStatus('Buscando anfitrión');}});
    sayHello();helloTimer=setInterval(sayHello,1300);
    $('#join-panel').classList.add('hidden');
  }catch(e){failConnection('No se pudo conectar',e.message||'Revisa tu conexión e inténtalo de nuevo.');$('#join-game').disabled=false;}
  finally{joining=false;}
}
function leaveToCode(){
  clearTimers();bus?.close();bus=null;closePeer();
  $('#join-panel').classList.remove('hidden');$('#join-game').disabled=false;
  $('#join-error').textContent='';dismissConnection();topStatus('Sin conectar');
  $('#room-code').focus();
}
$('#join-game').addEventListener('click',()=>void join());
$('#room-code').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void join();}});
$('#retry-join').addEventListener('click',()=>{if(!joining){$('#room-code').value=currentCode;void join();}});
$('#change-code').addEventListener('click',leaveToCode);
$('#toggle').addEventListener('click',()=>setControls(!playing));

// Relative FPS input when guest pointer is locked; absolute normalized coordinates otherwise.
function position(e){
  const rect=videoBox.getBoundingClientRect();
  const vw=video.videoWidth||rect.width, vh=video.videoHeight||rect.height;
  const scale=Math.min(rect.width/vw,rect.height/vh);
  const w=vw*scale,h=vh*scale;
  const left=rect.left+(rect.width-w)/2,top=rect.top+(rect.height-h)/2;
  const x=e&&Number.isFinite(e.clientX)?(e.clientX-left)/w:.5;
  const y=e&&Number.isFinite(e.clientY)?(e.clientY-top)/h:.5;
  return {x:ArcInput.clamp(x,0,1),y:ArcInput.clamp(y,0,1)};
}
let cursorPosition={x:.5,y:.5};
// Keep only the freshest state. Cumulative deltas recover dropped unordered packets.
// Never queue a long tail of outdated mouse moves behind congestion.
function sendMove(){
  motionTimer=null;
  if(!pendingMotion||!playing||movement?.readyState!=='open')return;
  if(movement.bufferedAmount>768){
    // Retry the newest cumulative state instead of sending stale snapshots.
    motionTimer=setTimeout(sendMove,4);
    return;
  }
  pendingMotion=false;
  lastMotionAt=performance.now();
  try{movement.send(JSON.stringify({t:'move',s:++motionSeq,ax:totalMX,ay:totalMY,x:cursorPosition.x,y:cursorPosition.y,locked:!!document.pointerLockElement}));}catch{}
  // Two short repeats repair a lost final mouse packet without retransmitting
  // old movement: host applies cumulative position differences only once.
  if(motionRecoveryTimer===null&&motionRepeats<2){
    motionRecoveryTimer=setTimeout(()=>{
      motionRecoveryTimer=null;
      if(!playing||!connected)return;
      motionRepeats++;pendingMotion=true;sendMove();
    },38);
  }
}
function queueMove(e){
  if(!playing||!connected)return;
  if(motionRecoveryTimer!==null){clearTimeout(motionRecoveryTimer);motionRecoveryTimer=null;}
  motionRepeats=0;
  const locked=!!document.pointerLockElement;
  if(locked){totalMX+=e.movementX||0;totalMY+=e.movementY||0;}
  else cursorPosition=position(e);
  pendingMotion=true;
  if(!motionTimer){
    const delta=performance.now()-lastMotionAt;
    // FPS: up to 120 Hz. Normal cursor: up to 60 Hz to save CPU.
    const minInterval=locked?8:16;
    if(delta>=minInterval)sendMove();
    else motionTimer=setTimeout(sendMove,Math.max(1,minInterval-delta));
  }
}
videoBox.addEventListener('mousemove',e=>{if(!document.pointerLockElement)queueMove(e);});
document.addEventListener('mousemove',e=>{if(document.pointerLockElement)queueMove(e);});
async function lockPointer(){
  if(!playing||!connected)return;
  try{await videoBox.requestPointerLock({unadjustedMovement:true});}
  catch{try{await videoBox.requestPointerLock();}catch{$('#mouse-guide').querySelector('span').textContent='No se ha podido capturar el ratón. Haz clic en el juego o vuelve a intentarlo.';}}
}
$('#lock-mouse').addEventListener('click',()=>{
  if(document.pointerLockElement)document.exitPointerLock();
  else void lockPointer();
});
// The video is directly clickable even while normal desktop-style mouse controls are enabled.
videoBox.addEventListener('mousedown',e=>{
  if(!playing||!connected||e.target.closest('.game-hud'))return;
  const label=['left','middle','right','back','forward'][e.button];
  if(!label)return;
  e.preventDefault();if(!document.pointerLockElement)cursorPosition=position(e);
  if(!(mouseMask&mouseButtons[label])){mouseMask|=mouseButtons[label];sendEdge('button',label,true);}
});
window.addEventListener('mouseup',e=>{
  if(!playing)return;
  const label=['left','middle','right','back','forward'][e.button];
  if(!label||!(mouseMask&mouseButtons[label]))return;
  e.preventDefault();if(!document.pointerLockElement)cursorPosition=position(e);
  mouseMask&=~mouseButtons[label];sendEdge('button',label,false);
});
videoBox.addEventListener('contextmenu',e=>{if(playing)e.preventDefault();});
videoBox.addEventListener('auxclick',e=>{if(playing)e.preventDefault();});
videoBox.addEventListener('wheel',e=>{
  if(!playing||!connected||e.target.closest('.game-hud'))return;
  e.preventDefault();cursorPosition=position(e);
  // deltaMode 1 = line, 2 = page; normalize to CSS pixels.
  const f=e.deltaMode===1?16:e.deltaMode===2?720:1;
  sendControl({t:'wheel',dx:ArcInput.clamp(e.deltaX*f,-2000,2000),dy:ArcInput.clamp(e.deltaY*f,-2000,2000),...cursorPosition});
},{passive:false});
document.addEventListener('pointerlockchange',()=>{
  const locked=!!document.pointerLockElement;
  document.body.classList.toggle('pointer-locked',locked);
  // Reliable and immediate: hide the cursor on the HOST tab even at rest.
  if(connected)sendControl({t:'pointer-mode',locked:locked&&playing});
  $('#lock-mouse').textContent=locked?'Liberar ratón':'Capturar ratón';
  if(!locked){resetInputs();pendingMotion=false;}
});

window.addEventListener('keydown',e=>{
  if(!playing||!connected||!ArcInput.allowed(e.code))return;
  // Esc is reserved to release Pointer Lock; the game will not receive it while locked.
  if(e.code==='Escape'&&document.pointerLockElement){document.exitPointerLock();return;}
  e.preventDefault();e.stopPropagation();
  if(e.repeat||pressed.has(e.code)||pressed.size>=32)return;
  pressed.add(e.code);sendEdge('key',e.code,true);
},true);
window.addEventListener('keyup',e=>{
  if(!pressed.has(e.code))return;
  e.preventDefault();e.stopPropagation();pressed.delete(e.code);sendEdge('key',e.code,false);
},true);
window.addEventListener('blur',resetInputs);
document.addEventListener('visibilitychange',()=>{if(document.hidden)resetInputs();});
$('#fullscreen').addEventListener('click',()=>{
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
  else videoBox.requestFullscreen().catch(()=>{});
});
$('#sound').addEventListener('click',()=>{
  soundEnabled=!soundEnabled;video.muted=!soundEnabled;
  $('#sound').title=soundEnabled?'Silenciar':'Activar sonido';
  video.play().catch(()=>{});
});
window.addEventListener('beforeunload',()=>{stopControls();bus?.close();});

// Support both hash-based private invitation links and explicit URL parameters.
// Remove the secret from the visible URL immediately after reading it.
(function joinFromLink(){
  const url=new URL(location.href);
  let value=url.searchParams.get('room')||url.searchParams.get('code')||url.searchParams.get('invite')||'';
  if(!value){
    const fragment=location.hash.slice(1);
    if(fragment){
      const p=new URLSearchParams(fragment);
      value=p.get('room')||p.get('code')||p.get('invite')||fragment;
    }
  }
  if(!value)return;
  try{value=decodeURIComponent(value);}catch{}
  $('#room-code').value=value;
  history.replaceState(null,'',location.pathname);
  void join();
})();
// One-time intro is separate from the connection screen and never repeats during a match.
setTimeout(()=>document.getElementById('boot-splash')?.remove(),1000);
