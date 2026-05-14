// ==UserScript==
// @name         HELLO TEST — diagnóstico
// @namespace    https://github.com/ThCarmo/tribal-wars-userscript
// @version      1.0.0
// @description  Teste mínimo: se este script funciona, Tampermonkey está OK
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

document.body.style.border = '20px solid red';
document.title = '[HELLO TEST] ' + document.title;
var d = document.createElement('div');
d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:fuchsia;color:white;padding:20px;font-size:24px;font-weight:bold;z-index:2147483647;text-align:center;';
d.textContent = 'HELLO TEST FUNCIONANDO';
document.body.appendChild(d);
console.log('[HELLO TEST] OK em', location.href);
