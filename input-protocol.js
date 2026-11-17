/* ArcPlay input mapping: DOM physical keyboard codes to Chrome DevTools Protocol. */
(function(root){
  'use strict';
  const special = {
    Backquote:['`',192], Minus:['-',189], Equal:['=',187], BracketLeft:['[',219],
    BracketRight:[']',221], Backslash:['\\',220], Semicolon:[';',186], Quote:["'",222],
    Comma:[',',188], Period:['.',190], Slash:['/',191], IntlBackslash:['\\',226],
    IntlRo:['\\',193], IntlYen:['¥',255],
    Space:[' ',32], Enter:['Enter',13], NumpadEnter:['Enter',13], Tab:['Tab',9],
    Escape:['Escape',27], Backspace:['Backspace',8], Delete:['Delete',46], Insert:['Insert',45],
    Home:['Home',36], End:['End',35], PageUp:['PageUp',33], PageDown:['PageDown',34],
    ArrowLeft:['ArrowLeft',37], ArrowUp:['ArrowUp',38], ArrowRight:['ArrowRight',39], ArrowDown:['ArrowDown',40],
    ShiftLeft:['Shift',16],ShiftRight:['Shift',16],ControlLeft:['Control',17],ControlRight:['Control',17],
    AltLeft:['Alt',18],AltRight:['Alt',18],MetaLeft:['Meta',91],MetaRight:['Meta',92],
    CapsLock:['CapsLock',20],NumLock:['NumLock',144],ScrollLock:['ScrollLock',145],
    Pause:['Pause',19],PrintScreen:['PrintScreen',44],ContextMenu:['ContextMenu',93],
    NumpadAdd:['+',107],NumpadSubtract:['-',109],NumpadMultiply:['*',106],
    NumpadDivide:['/',111],NumpadDecimal:['.',110],NumpadEqual:['=',187],NumpadComma:[',',194]
  };
  const buttons = {left:1,right:2,middle:4,back:8,forward:16};
  function allowed(code){
    return typeof code === 'string' && (Object.hasOwn(special,code) ||
      /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(code));
  }
  function keyInfo(code){
    if(!allowed(code)) return null;
    let key, vk;
    if (special[code]) [key,vk] = special[code];
    else if (/^Key[A-Z]$/.test(code)) {key=code[3].toLowerCase();vk=code.charCodeAt(3);}
    else if (/^Digit[0-9]$/.test(code)) {key=code[5];vk=code.charCodeAt(5);}
    else if (/^Numpad[0-9]$/.test(code)) {key=code[6];vk=96+Number(key);}
    else if (/^F\d+$/.test(code)) {key=code;vk=111+Number(code.slice(1));}
    const location=code.startsWith('Numpad')?3:code.endsWith('Right')?2:code.endsWith('Left')?1:0;
    return {key,code,vk,location};
  }
  const clamp=(v,low,high)=>Math.min(high,Math.max(low,v));
  const validCoord=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
  const validDelta=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=20000;
  root.ArcInput=Object.freeze({allowed,keyInfo,buttons,clamp,validCoord,validDelta});
})(typeof self!=='undefined'?self:globalThis);
