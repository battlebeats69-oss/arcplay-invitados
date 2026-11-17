/* Optional external connectivity settings. Direct WebRTC is always attempted first. */
(function (global) {
  'use strict';
  const DEFAULTS = [{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302','stun:stun.cloudflare.com:3478']}];
  function validate(items) {
    if (!Array.isArray(items) || items.length > 5) return [];
    const valid = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter(url =>
        typeof url === 'string' && url.length < 260 && /^(stun|stuns|turn|turns):[^\s]+$/i.test(url));
      if (!urls.length || urls.length > 6) continue;
      const isTurn = urls.some(url=>/^turns?:/i.test(url));
      if (isTurn && (!item.username || !item.credential)) continue;
      if (isTurn && (typeof item.username !== 'string' || typeof item.credential !== 'string' ||
          item.username.length > 512 || item.credential.length > 512)) continue;
      const out = {urls};
      if (isTurn) {out.username=item.username;out.credential=item.credential;}
      valid.push(out);
    }
    return valid;
  }
  function merge(extra) {return [...DEFAULTS, ...validate(extra)];}
  global.ArcIce = {validate,merge,DEFAULTS};
})(globalThis);
