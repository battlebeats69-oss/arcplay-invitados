/* ArcPlay AP2 invitation format. Only invite tokens are generated here; signaling uses Trystero. */
(function(root){
  'use strict';
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const decode = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)), x=>x.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const hex = x => Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
  function makeCode(){return `AP2-${hex(rand(16))}-${encode(rand(32))}`;}
  function parseCode(value){
    const code=String(value||'').trim().replace(/\s+/g,'');
    const m=/^AP2-([0-9a-f]{32})-([a-zA-Z0-9_-]{43})$/.exec(code);
    if(!m||decode(m[2]).length!==32)throw Error('El código de invitación no es válido');
    return {code,room:m[1],secret:m[2]};
  }
  root.ArcSignal={makeCode,parseCode};
})(typeof globalThis!=='undefined'?globalThis:this);
