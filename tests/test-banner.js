var d=document.createElement('div');
d.style.cssText='position:fixed;top:0;left:0;right:0;background:lime;color:black;padding:30px;font-size:30px;font-weight:bold;z-index:99999999;text-align:center;';
d.textContent='JS FUNCIONOU - userscript pode rodar aqui';
document.body.insertAdjacentElement('afterbegin',d);
console.log('TESTE OK');
