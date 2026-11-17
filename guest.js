/* Guest session: paste invitation -> WebRTC video/audio and shared keyboard. */
'use strict';
const $ = selector => document.querySelector(selector);
const allowed = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(s => 'Key'+s),
  ...'0123456789'.split('').map(s => 'Digit'+s),
  ...Array.from({length:10},(_,i) => 'Numpad'+i),
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter','ShiftLeft','ShiftRight',
  'NumpadEnter','Comma','Period','Slash','Semicolon','Quote','BracketLeft','BracketRight','Backslash','Minus','Equal'
]);
const pressed = new Set();
const iceServers = [{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
const myId = crypto.randomUUID();
let bus=null, pc=null, channel=null, hostId='', playing=false, connected=false;
let seq=0, keyInterval=null, helloInterval=null, pingInterval=null, pendingIce=[];
let connecting=false, rtcConnected=false, lastOfferAt=0;
function topStatus(message,on=false){$('#top-status').textContent=message;$('#dot').classList.toggle('on',on);}
function connStatus(message){$('#conn-status').textContent=message;}
function waiting(title,description){$('#waiting').style.display='block';$('#waiting-title').textContent=title;$('#waiting-sub').textContent=description;$('#video').classList.remove('ready');}
function setControlsEnabled(enabled){connected=enabled;$('#toggle').disabled=!enabled;if(!enabled)disablePlay();$('#toggle-label').textContent=enabled?'Activar mis teclas':'Esperando conexión';}
function updatePressed(){
 const codes = new Set(pressed);
 const map=['ArrowUp','ArrowLeft','ArrowDown','ArrowRight','Enter','KeyW','Space'];
 document.querySelectorAll('.keys span').forEach((node,i) => node.classList.toggle('pressed',codes.has(map[i])||(i===5&&['KeyW','KeyA','KeyS','KeyD'].some(k=>codes.has(k)))));
}
function pushSnapshot(){
 if(channel?.readyState!=='open'||channel.bufferedAmount>12000)return;
 try{channel.send(JSON.stringify({t:'k',k:[...pressed].slice(0,12),s:++seq}));}catch{}
}
function disablePlay(){pressed.clear();pushSnapshot();playing=false;$('#toggle').classList.remove('playing');if(connected)$('#toggle-label').textContent='Activar mis teclas';updatePressed();}
function closePeer(){
 disablePlay();setControlsEnabled(false);
 clearInterval(keyInterval);clearInterval(pingInterval);keyInterval=null;pingInterval=null;
 if(channel){try{channel.close();}catch{}}channel=null;
 if(pc){try{pc.close();}catch{}}pc=null;
 rtcConnected=false;pendingIce=[];$('#ping').textContent='— ms';
}
function signal(data){if(bus)void bus.send({...data,from:myId,to:hostId}).catch(()=>{});}
async function openPeer(){
 // Don't erase ICE that arrived slightly before the offer.
 const earlyIce=pendingIce;
 closePeer();pendingIce=earlyIce;
 const connection=new RTCPeerConnection({iceServers,bundlePolicy:'max-bundle'});pc=connection;
 const media = new MediaStream();
 connection.ontrack=event=>{
   if(!media.getTracks().includes(event.track))media.addTrack(event.track);
   $('#video').srcObject=media;$('#video').classList.add('ready');$('#waiting').style.display='none';
   $('#video').play().catch(()=>{});
   connStatus('Vídeo en directo');
 };
 connection.ondatachannel=event=>{
   if(event.channel.label!=='arcplay-keys')return;
   channel=event.channel;
   channel.onopen=()=>{
     rtcConnected=true;setControlsEnabled(true);topStatus('Conectado',true);connStatus('Control conectado');
     seq=0;
     keyInterval=setInterval(()=>{if(channel?.readyState==='open')pushSnapshot();},85);
     pingInterval=setInterval(()=>{if(channel?.readyState==='open'&&channel.bufferedAmount<12000)channel.send(JSON.stringify({t:'ping',n:performance.now()}));},950);
   };
   channel.onclose=()=>{rtcConnected=false;setControlsEnabled(false);topStatus('Reconectando');connStatus('Controles desconectados');};
   channel.onmessage=e=>{
     try{const msg=JSON.parse(e.data);if(msg.t==='pong'&&typeof msg.n==='number')$('#ping').textContent=Math.round(performance.now()-msg.n)+' ms';}catch{}
   };
 };
 connection.onicecandidate=e=>{if(e.candidate&&pc===connection)signal({t:'candidate',candidate:e.candidate.toJSON()});};
 connection.onconnectionstatechange=()=>{
   if(pc!==connection)return;
   if(connection.connectionState==='failed'){
     rtcConnected=false;topStatus('Sin conexión');connStatus('No se pudo establecer la conexión');
     waiting('No se pudo conectar','Prueba otra red y vuelve a entrar.');
   }
   if(connection.connectionState==='disconnected'){rtcConnected=false;topStatus('Reconectando');}
 };
}
async function onSignal(message){
 if(message.to&&message.to!==myId)return;
 if(message.t==='offer'){
   if(!message.description||message.description.type!=='offer'||typeof message.from!=='string')return;
   if(pc?.connectionState==='connected'&&rtcConnected)return;
   if(pc?.signalingState==='have-remote-offer'&&Date.now()-lastOfferAt<4000)return;
   hostId=message.from;lastOfferAt=Date.now();
   await openPeer();
   await pc.setRemoteDescription(message.description);
   const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
   signal({t:'answer',description:pc.localDescription});
   for(const candidate of pendingIce){try{await pc.addIceCandidate(candidate);}catch{}}
   pendingIce=[];
   topStatus('Conectando');connStatus('Recibiendo partida...');
 }else if(message.t==='candidate' && message.candidate){
   if(hostId&&message.from!==hostId)return;
   if(pc?.remoteDescription){try{await pc.addIceCandidate(message.candidate);}catch{}}
   else if(pendingIce.length<100) pendingIce.push(message.candidate);
 }
}
function sayHello(){if(bus&&!rtcConnected)void bus.send({t:'hello',from:myId}).catch(()=>{});}
async function join(){
 if(connecting)return;
 let code;
 try{code=ArcSignal.parseCode($('#room-code').value).code;}
 catch(err){$('#join-error').textContent=err.message;return;}
 connecting=true;$('#join-error').textContent='';$('#join-game').disabled=true;
 try{
   bus?.close();bus=null;clearInterval(helloInterval);closePeer();hostId='';
   topStatus('Conectando');connStatus('Buscando partida');
   bus=await ArcSignal.SignalBus.connect(code,'guest',message=>{
     void onSignal(message).catch(err=>{connStatus('Error al conectar: '+err.message);});
   },ready=>{
     if(ready){sayHello();if(!rtcConnected)topStatus('Buscando anfitrión');}
     else if(!rtcConnected)topStatus('Conectando');
   });
   helloInterval=setInterval(sayHello,1800);
   $('#join-panel').classList.add('hidden');
   waiting('Buscando la partida...','Tu amigo debe haber pulsado «Compartir esta pestaña».');
 }catch(err){$('#join-error').textContent=err.message;$('#join-game').disabled=false;}
 finally{connecting=false;}
}
$('#join-game').addEventListener('click',()=>void join());
$('#room-code').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void join();}});
$('#toggle').addEventListener('click',()=>{
 if(!connected)return;
 if(playing)disablePlay();
 else{playing=true;$('#toggle-label').textContent='Desactivar controles';$('#toggle').classList.add('playing');$('#keyboard-focus').focus({preventScroll:true});$('#video').play().catch(()=>{});}
});
window.addEventListener('keydown',e=>{
 if(!playing||!allowed.has(e.code)||e.ctrlKey||e.altKey||e.metaKey)return;
 e.preventDefault();if(e.repeat||pressed.has(e.code)||pressed.size>=12)return;
 pressed.add(e.code);pushSnapshot();updatePressed();
},true);
window.addEventListener('keyup',e=>{
 if(!pressed.has(e.code))return;e.preventDefault();pressed.delete(e.code);pushSnapshot();updatePressed();
},true);
window.addEventListener('blur',()=>{pressed.clear();pushSnapshot();updatePressed();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){pressed.clear();pushSnapshot();updatePressed();}});
$('#fullscreen').addEventListener('click',()=>{$('#video-box').requestFullscreen().catch(()=>{});});
$('#sound').addEventListener('click',()=>{
 const v=$('#video');v.muted=!v.muted;
 $('#sound').title=v.muted?'Activar sonido':'Silenciar';
 $('#note').textContent=v.muted?'Sonido silenciado. Pulsa el icono de sonido para escucharlo.':'Sonido activo. Puedes activar el teclado para jugar.';
 v.play().catch(()=>{});
});
window.addEventListener('beforeunload',()=>{disablePlay();bus?.close();});

// A link containing the private invitation in its fragment lets guests join without an extension.
// The fragment stays client-side and is never sent as part of the page request.
(function joinFromLink() {
  const fragment = location.hash.slice(1);
  if (!fragment) return;
  let code = fragment;
  if (fragment.startsWith('room=')) code = fragment.slice(5);
  try {code = decodeURIComponent(code);} catch {}
  try {
    $('#room-code').value = ArcSignal.parseCode(code).code;
    history.replaceState(null, '', location.pathname + location.search);
    void join();
  } catch {
    $('#join-error').textContent = 'El enlace de invitación no es válido.';
  }
})();

// Remove the one-second intro from the DOM; no ongoing animation while playing.
setTimeout(() => document.getElementById('boot-splash')?.remove(), 1000);
