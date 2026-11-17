/* ArcPlay guest v1.3 — Trystero/Nostr, media and input over one P2P connection. */
'use strict';
const $=s=>document.querySelector(s);
const pressed=new Set(),mouseButtons=ArcInput.buttons;
let room=null,control=null,movement=null,feedbackAction=null,hostId='';
let fastMotion=null;
let connected=false,playing=false,videoReady=false,mouseMask=0;
let joining=false,channelConnected=false,peerConnected=false,currentCode='';
let hostFound=false,roomServiceReady=false,offerReceived=false;
let errorTimer=null,safetyTimer=null,pingTimer=null,latencyTimer=null;
let motionTimer=null,motionRecoveryTimer=null,motionRepeats=0,pendingMotion=false,motionSeq=0,totalMX=0,totalMY=0,lastMotionAt=0;
let soundEnabled=false;
const video=$('#video'),videoBox=$('#video-box');
function topStatus(text,on=false){$('#top-status').textContent=text;$('#dot').classList.toggle('on',on);}
function setConnection(title,description,failed=false){
  const layer=$('#connection-screen');layer.hidden=false;layer.classList.toggle('error',failed);
  $('#connection-eyebrow').textContent=failed?'NO SE PUDO CONECTAR':'INVITACIÓN RECIBIDA';
  $('#connection-title').textContent=title;$('#connection-description').textContent=description;
  $('#connection-actions').hidden=!failed;layer.setAttribute('role',failed?'alert':'status');
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
    if(!hostFound)failConnection('No encontramos la partida','El anfitrión no aparece en la sala. Comprueba la invitación y que tenga ArcPlay v1.3.');
    else if(!peerConnected)failConnection('Conexión P2P bloqueada','Las redes no pueden comunicarse. Prueba otra red o un servicio TURN. (NET-ICE)');
    else failConnection('No llega el vídeo','La conexión de control se abrió, pero todavía no hay vídeo. Comprueba que el anfitrión siga compartiendo.');
  },35000);
}
function maybeReady(){
  if(connected||!channelConnected||!videoReady||!peerConnected||control?.readyState!=='open')return;
  connected=true;clearTimeout(errorTimer);errorTimer=null;
  dismissConnection();document.body.classList.add('is-playing');
  $('#toggle').disabled=false;$('#toggle-label').textContent='Activar controles';
  topStatus('Conectado',true);video.play().catch(()=>{});
}
function sendControl(obj){
  if(control?.readyState!=='open'||control.bufferedAmount>10000)return;
  try{control.send(JSON.stringify(obj));}catch{}
}
function snapshot(){sendControl({t:'snapshot',k:[...pressed],b:mouseMask});}
function sendEdge(kind,value,down){
  if(kind==='key')sendControl({t:'edge',kind,code:value,down});
  else sendControl({t:'edge',kind,button:value,down,x:cursorPosition.x,y:cursorPosition.y,locked:!!document.pointerLockElement});
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
  sendControl({t:'pointer-mode',locked:false});sendControl({t:'input-active',on:false});
  resetInputs();playing=false;
  if(document.pointerLockElement)document.exitPointerLock();
  document.body.classList.remove('pointer-locked');$('#toggle').classList.remove('playing');
  $('#toggle-label').textContent=connected?'Activar controles':'Esperando conexión';
  $('#lock-mouse').disabled=true;$('#lock-mouse').textContent='Capturar ratón';
}
function setControls(on){
  if(!connected)return;
  if(!on){stopControls();return;}
  motionSeq=0;totalMX=0;totalMY=0;lastMotionAt=0;
  playing=true;sendControl({t:'input-active',on:true});
  sendControl({t:'pointer-mode',locked:!!document.pointerLockElement});
  snapshot();$('#toggle').classList.add('playing');$('#toggle-label').textContent='Desactivar controles';
  $('#lock-mouse').disabled=false;$('#keyboard-focus').focus({preventScroll:true});
  video.play().catch(()=>{});
}
function clearTimers(){
  for(const t of [errorTimer,safetyTimer,pingTimer,latencyTimer,motionTimer,motionRecoveryTimer])clearTimeout(t);
  errorTimer=safetyTimer=pingTimer=latencyTimer=motionTimer=motionRecoveryTimer=null;
}
function closePeer(){
  stopControls();clearInterval(safetyTimer);clearInterval(pingTimer);clearInterval(latencyTimer);
  safetyTimer=pingTimer=latencyTimer=null;
  try{fastMotion?.close();}catch{}fastMotion=null;
  control=movement=feedbackAction=null;hostId='';
  video.srcObject=null;video.classList.remove('ready');
  videoReady=channelConnected=peerConnected=connected=false;
  $('#ping').textContent='— ms';$('#toggle').disabled=true;
  document.body.classList.remove('is-playing');
}
function onVideoFrame(){
  if(video.readyState>=2){videoReady=true;video.classList.add('ready');$('#waiting').hidden=true;maybeReady();}
}
video.addEventListener('loadeddata',onVideoFrame);
video.addEventListener('playing',onVideoFrame);
function channel(action){
  let pending=0;
  return {
    readyState:'open',get bufferedAmount(){return pending;},
    send(value){
      if(!room||!hostId)return;
      const size=value.length;
      pending+=size;
      void action.send(JSON.parse(value),{target:hostId}).catch(()=>{}).finally(()=>{pending=Math.max(0,pending-size);});
    }
  };
}
function configurePeer(userId,actions){
  if(hostId&&hostId!==userId)return;
  hostId=userId;hostFound=true;peerConnected=true;channelConnected=true;
  control=channel(actions.input);movement=channel(actions.move);
  // Optional UDP-like unordered motion: same peer connection, no second handshake.
  // The reliable Trystero action remains a fallback on browsers where this is unavailable.
  try{
    const peer=Object.values(room.getPeers()).find(p=>p.userId===userId&&p.connection);
    if(peer?.connection){
      peer.connection.addEventListener('datachannel',e=>{
        if(e.channel.label!=='arcplay-fast-motion')return;
        fastMotion=e.channel;
        fastMotion.bufferedAmountLowThreshold=128;
        movement=fastMotion;
        fastMotion.onclose=()=>{fastMotion=null;movement=channel(actions.move);};
      });
    }
  }catch{}
  setConnection('Anfitrión encontrado','Recibiendo imagen y preparando los controles.');
  safetyTimer=setInterval(()=>{if(playing)snapshot();},110);
  pingTimer=setInterval(()=>{if(connected)sendControl({t:'ping',n:performance.now()});},1000);
  latencyTimer=setInterval(async()=>{
    if(!room||!hostId)return;
    try{$('#ping').textContent=Math.round(await room.ping(hostId))+' ms';}catch{}
  },2700);
  maybeReady();
}
async function join(){
  if(joining)return;
  let info;
  try{info=ArcSignal.parseCode($('#room-code').value);}
  catch(e){$('#join-error').textContent=e.message;failConnection('Invitación no válida',e.message);return;}
  joining=true;currentCode=info.code;$('#join-error').textContent='';$('#join-game').disabled=true;
  try{
    clearTimers();const old=room;room=null;if(old)await old.leave();
    closePeer();hostFound=false;roomServiceReady=false;offerReceived=false;
    setConnection('Conectando a la partida...','Buscando a tu amigo y preparando el vídeo.');
    topStatus('Conectando');armTimeout();
    room=ArcTrystero.joinRoom({
      appId:'battlebeats69-oss/arcplay-trystero-v1',password:info.secret,
      identity:'none',maxUsers:2,
      relayConfig:{redundancy:5,warnOnRelayFailure:false}
    },info.room);
    const input=room.makeAction('input'),move=room.makeAction('move');
    const feedback=room.makeAction('feedback');feedbackAction=feedback;
    feedback.onMessage((data,{userId})=>{
      if(userId!==hostId)return;
      if(data?.t==='pong'&&Number.isFinite(data.n))$('#ping').textContent=Math.round(performance.now()-data.n)+' ms';
    });
    room.onPeerStream((media,{userId,metadata})=>{
      if(hostId&&userId!==hostId)return;
      if(metadata?.kind!=='game')return;
      video.srcObject=media;video.play().catch(()=>{});
      // A first frame AND a connected control channel are required to show the game.
      maybeReady();
    },{replay:true});
    room.onUserJoin(({userId})=>configurePeer(userId,{input,move}));
    room.onUserLeave(({userId})=>{
      if(userId!==hostId)return;
      closePeer();setConnection('Reconectando...','El anfitrión se ha desconectado.');armTimeout();
    });
    room.onError(err=>{
      if(err.code==='peer-connect-failed')failConnection('Conexión de red bloqueada','Los navegadores se encontraron, pero no pudieron abrir WebRTC. Es necesario TURN o cambiar de red. (NET-ICE)');
      else if(err.code==='room-full')failConnection('Partida completa','Esta sala ya tiene dos participantes.');
      else if(err.code==='decrypt-failed')failConnection('Invitación no válida','Los códigos no coinciden. Generad una invitación nueva.');
    });
    $('#join-panel').classList.add('hidden');
  }catch(err){failConnection('Error de conexión',err.message||'Comprueba el enlace y vuelve a intentarlo.');$('#join-game').disabled=false;}
  finally{joining=false;}
}
function leaveToCode(){
  clearTimers();const old=room;room=null;if(old)void old.leave();closePeer();
  $('#join-panel').classList.remove('hidden');$('#join-game').disabled=false;
  $('#join-error').textContent='';dismissConnection();topStatus('Sin conectar');$('#room-code').focus();
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
window.addEventListener('beforeunload',()=>{stopControls();void room?.leave();});

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
