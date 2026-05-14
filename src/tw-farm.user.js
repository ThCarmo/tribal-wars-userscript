// ==UserScript==
// @name         TW Farm + Tagger — ThCarmo
// @namespace    https://github.com/ThCarmo/tribal-wars-userscript
// @version      0.2.1
// @description  Farm (2L+1S, raio configurável) + Incoming Tagger (classifica tropa por velocidade)
// @author       Thiago Carmo
// @match        *://*.tribalwars.com.br/*
// @match        *://*.tribalwars.com.pt/*
// @match        *://*.die-staemme.de/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// @downloadURL  https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        radiusMax: 35,
        cooldownMin: 30,
        jitterMs: [3000, 7000],
        template: 'A',
        debugLog: true,
        // min/campo — mundo 142 (confirmar com prints reais; ajustar se mundo mudar config)
        unitSpeed: {
            spy: 9.0,
            light: 10.0,
            heavy: 11.0,
            axe: 18.0,
            sword: 22.0,
            spear: 18.0,
            ram: 30.0,
            catapult: 30.0,
            snob: 35.0,
        },
    };

    const STATE = {
        running: false,
        sent: 0,
        errors: 0,
        lastError: '-',
        nextTarget: '-',
        lastFarmByTarget: GM_getValue('lastFarmByTarget', {}),
        troopsAtHome: { light: 0, spy: 0 },
        taggerRunning: false,
        taggerProgress: 'ocioso',
    };

    const w = unsafeWindow;
    const log = (...args) => CFG.debugLog && console.log('%c[TW-FARM]', 'color:#603000;font-weight:bold', ...args);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => Math.floor(CFG.jitterMs[0] + Math.random() * (CFG.jitterMs[1] - CFG.jitterMs[0]));

    function serverTime() {
        try {
            if (w.Timing && typeof w.Timing.getCurrentServerTime === 'function') {
                return w.Timing.getCurrentServerTime();
            }
        } catch (e) {}
        return Date.now();
    }

    function distance(x1, y1, x2, y2) {
        return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
    }

    function persistFarmRecord(targetId) {
        STATE.lastFarmByTarget[targetId] = serverTime();
        GM_setValue('lastFarmByTarget', STATE.lastFarmByTarget);
    }

    function isOnCooldown(targetId) {
        const last = STATE.lastFarmByTarget[targetId];
        if (!last) return false;
        return (serverTime() - last) < CFG.cooldownMin * 60 * 1000;
    }

    function isOnAmFarmScreen() {
        return location.search.includes('screen=am_farm');
    }

    function getGameData() {
        return w.game_data || null;
    }

    function extractTargets() {
        const gd = getGameData();
        if (!gd || !gd.village) {
            log('game_data.village indisponível');
            return [];
        }
        const sourceX = gd.village.x;
        const sourceY = gd.village.y;

        const rows = document.querySelectorAll('#plunder_list tbody tr, table.vis tbody tr');
        const targets = [];

        rows.forEach(row => {
            const targetLink = row.querySelector('a[href*="info_village.php"], a[href*="screen=info_village"]');
            if (!targetLink) return;

            const idMatch = targetLink.href.match(/[?&]id=(\d+)/);
            if (!idMatch) return;
            const targetId = idMatch[1];

            const coordMatch = (targetLink.textContent + ' ' + targetLink.title).match(/\((\d{1,4})\|(\d{1,4})\)/);
            if (!coordMatch) return;
            const tx = parseInt(coordMatch[1], 10);
            const ty = parseInt(coordMatch[2], 10);
            const dist = distance(sourceX, sourceY, tx, ty);
            if (dist > CFG.radiusMax) return;

            const buttonA =
                row.querySelector('a.farm_icon_a') ||
                row.querySelector('a[onclick*="farmA"]') ||
                row.querySelector('a[href*="from=A"]') ||
                row.querySelector('a.farm_icon[data-template="a"]') ||
                row.querySelector('.farm-icon-a');
            if (!buttonA) return;

            targets.push({ id: targetId, x: tx, y: ty, dist, buttonA });
        });

        targets.sort((a, b) => a.dist - b.dist);
        return targets;
    }

    function readTroopsFromGameData() {
        const gd = getGameData();
        const units = gd && gd.village && (gd.village.unit_amount || gd.village.units);
        if (units && typeof units === 'object') {
            return {
                light: parseInt(units.light, 10) || 0,
                spy: parseInt(units.spy, 10) || 0,
            };
        }
        return null;
    }

    function readTroopsFromDom() {
        // am_farm tipicamente tem na barra superior um sumário das tropas
        // tentamos múltiplos seletores comuns
        const tryNum = sel => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) ? n : null;
        };
        const lightSelectors = [
            'a[href*="screen=place"] .unit-item-light',
            'td.unit-item-light',
            '#unit_input_light',
            'input[name="light"][data-bind*="amount"]',
            'tr#unit_input_table td.unit_light',
        ];
        const spySelectors = [
            'a[href*="screen=place"] .unit-item-spy',
            'td.unit-item-spy',
            '#unit_input_spy',
            'input[name="spy"][data-bind*="amount"]',
            'tr#unit_input_table td.unit_spy',
        ];
        let light = null, spy = null;
        for (const s of lightSelectors) { if (light == null) light = tryNum(s); }
        for (const s of spySelectors) { if (spy == null) spy = tryNum(s); }
        if (light == null && spy == null) return null;
        return { light: light || 0, spy: spy || 0 };
    }

    function syncTroopsAtHome() {
        const fromGd = readTroopsFromGameData();
        const fromDom = readTroopsFromDom();
        const picked = fromGd || fromDom;
        if (picked) {
            STATE.troopsAtHome = picked;
            log('Tropas em casa sincronizadas:', picked, fromGd ? '(via game_data)' : '(via DOM)');
            return true;
        }
        log('Falha ao sincronizar tropas — ajustar manual no painel');
        return false;
    }

    function captchaActive() {
        return !!document.querySelector('#popup_box_captcha, #bot_check, .captcha, [id*="captcha"]');
    }

    function errorMessageInDom() {
        const errEl = document.querySelector('.error_box, .autocomplete-suggestions .error, #message_area .error');
        return errEl ? errEl.textContent.trim().slice(0, 120) : null;
    }

    async function farmLoop() {
        if (!isOnAmFarmScreen()) {
            updatePanel('erro: abra Assistente de Saque (am_farm) primeiro');
            STATE.running = false;
            return;
        }

        log('Loop iniciado. raioMax:', CFG.radiusMax, 'cooldownMin:', CFG.cooldownMin);
        syncTroopsAtHome();

        while (STATE.running) {
            if (captchaActive()) {
                STATE.lastError = 'Proteção contra Bots ativa';
                updatePanel('PARADO — captcha. Resolva manualmente.');
                STATE.running = false;
                break;
            }

            if (STATE.troopsAtHome.light < 2) {
                STATE.lastError = `CL em casa: ${STATE.troopsAtHome.light} (precisa ≥2)`;
                updatePanel('PARADO — CL esgotada. Aguardando retorno.');
                STATE.running = false;
                break;
            }

            const targets = extractTargets();
            const ready = targets.filter(t => !isOnCooldown(t.id));

            if (targets.length === 0) {
                updatePanel(`0 alvos no raio ${CFG.radiusMax}. Aguardando 60s...`);
                await sleep(60000);
                continue;
            }
            if (ready.length === 0) {
                updatePanel(`${targets.length} alvos no raio, todos em cooldown. Aguardando 60s...`);
                await sleep(60000);
                continue;
            }

            const next = ready[0];
            STATE.nextTarget = `(${next.x}|${next.y}) ${next.dist.toFixed(1)}c`;
            updatePanel(`enviando ${STATE.nextTarget}`);

            try {
                next.buttonA.click();
                await sleep(400);
                const err = errorMessageInDom();
                if (err) {
                    STATE.errors++;
                    STATE.lastError = err;
                    log('Erro do servidor:', err);
                    if (/captcha|bot|provis/i.test(err)) {
                        STATE.running = false;
                        updatePanel('PARADO — servidor reclamou de bot/captcha');
                        break;
                    }
                } else {
                    persistFarmRecord(next.id);
                    STATE.sent++;
                    STATE.troopsAtHome.light -= 2;
                    STATE.troopsAtHome.spy -= 1;
                    log(`Farm ${STATE.sent} enviado:`, STATE.nextTarget, 'estoque:', STATE.troopsAtHome);
                }
            } catch (err) {
                STATE.errors++;
                STATE.lastError = err.message || String(err);
                log('Exceção no clique:', err);
            }

            await sleep(jitter());
        }

        updatePanel(`parado — ${STATE.sent} enviados, ${STATE.errors} erros`);
    }

    // ============ INCOMING TAGGER ============

    function classifyByVelocity(minPerField) {
        const s = CFG.unitSpeed;
        const m = minPerField;
        if (m < (s.spy + s.light) / 2) return { label: 'SPY?', conf: 'alta' };
        if (m < (s.light + s.heavy) / 2) return { label: 'CL?', conf: 'alta' };
        if (m < (s.heavy + s.axe) / 2) return { label: 'CP?', conf: 'média' };
        if (m < (s.axe + s.ram) / 2) return { label: 'OFF?', conf: 'média' };
        if (m < (s.ram + s.snob) / 2) return { label: 'NT_OU_ARIETE?', conf: 'baixa' };
        return { label: 'NT?', conf: 'alta' };
    }

    async function fetchIncomingsPage() {
        const url = '/game.php?screen=overview_villages&mode=incomings';
        const resp = await fetch(url, { credentials: 'same-origin' });
        const html = await resp.text();
        const parser = new DOMParser();
        return parser.parseFromString(html, 'text/html');
    }

    function parseIncomingsFromDoc(doc) {
        const out = [];
        const rows = doc.querySelectorAll('table.vis tbody tr, #incomings_table tbody tr, table[id*="incomings"] tbody tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 4) return;

            const cmdLink = row.querySelector('a[href*="info_command"], a[href*="screen=info_command"]');
            if (!cmdLink) return;
            const cmdIdMatch = cmdLink.href.match(/[?&]id=(\d+)/);
            if (!cmdIdMatch) return;
            const cmdId = cmdIdMatch[1];

            const srcLink = row.querySelector('a[href*="info_village"], a[href*="screen=info_village"]');
            const srcCoord = srcLink ? (srcLink.textContent.match(/\((\d+)\|(\d+)\)/) || []) : [];

            const rowText = row.innerText || row.textContent || '';
            const dstCoord = rowText.match(/\((\d+)\|(\d+)\)\s*K\d+/g);

            const timeMatch = rowText.match(/(\d{2}:\d{2}:\d{2}:\d{3})|(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/);

            out.push({
                cmdId,
                srcX: srcCoord[1] ? parseInt(srcCoord[1]) : null,
                srcY: srcCoord[2] ? parseInt(srcCoord[2]) : null,
                rawText: rowText.replace(/\s+/g, ' ').trim().slice(0, 200),
                arrival: timeMatch ? timeMatch[0] : null,
            });
        });
        return out;
    }

    async function fetchCommandDetail(cmdId) {
        const url = `/game.php?screen=info_command&id=${cmdId}`;
        const resp = await fetch(url, { credentials: 'same-origin' });
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const text = doc.body.innerText || doc.body.textContent || '';
        const arrivalMatch = text.match(/Chegada[^\d]*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}):?(\d{3})?/i);
        const departureMatch = text.match(/Sa[íi]da[^\d]*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}):?(\d{3})?/i);

        const srcCoordMatch = text.match(/Origem[^(]*\((\d+)\|(\d+)\)/i);
        const dstCoordMatch = text.match(/Destino[^(]*\((\d+)\|(\d+)\)/i);

        function parseTs(m) {
            if (!m) return null;
            const [_, d, t, ms] = m;
            const [dd, mm, yyyy] = d.split('/');
            const iso = `${yyyy}-${mm}-${dd}T${t}.${ms || '000'}-03:00`;
            const ts = Date.parse(iso);
            return Number.isFinite(ts) ? ts : null;
        }

        return {
            arrival: parseTs(arrivalMatch),
            departure: parseTs(departureMatch),
            srcX: srcCoordMatch ? parseInt(srcCoordMatch[1]) : null,
            srcY: srcCoordMatch ? parseInt(srcCoordMatch[2]) : null,
            dstX: dstCoordMatch ? parseInt(dstCoordMatch[1]) : null,
            dstY: dstCoordMatch ? parseInt(dstCoordMatch[2]) : null,
        };
    }

    async function setCommandLabel(cmdId, label) {
        const csrf = w.csrf_token || (w.game_data && w.game_data.csrf);
        const url = `/game.php?screen=info_command&ajaxaction=edit_other&id=${cmdId}${csrf ? '&h=' + csrf : ''}`;
        const fd = new FormData();
        fd.append('text', label);
        try {
            const r = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
            return r.ok;
        } catch (e) {
            log('setCommandLabel falhou:', e);
            return false;
        }
    }

    async function runTagger() {
        log('Tagger iniciado');
        STATE.taggerRunning = true;
        STATE.taggerProgress = 'buscando lista...';
        updatePanel(null);

        const doc = await fetchIncomingsPage();
        const list = parseIncomingsFromDoc(doc);
        log(`Tagger: ${list.length} ataques no overview`);

        if (list.length === 0) {
            STATE.taggerProgress = '0 incomings encontrados';
            STATE.taggerRunning = false;
            updatePanel(null);
            return;
        }

        let labeled = 0;
        let skipped = 0;
        for (let i = 0; i < list.length; i++) {
            if (!STATE.taggerRunning) break;
            const inc = list[i];
            STATE.taggerProgress = `analisando ${i + 1}/${list.length}`;
            updatePanel(null);

            const detail = await fetchCommandDetail(inc.cmdId);
            if (!detail.arrival || !detail.departure || !detail.srcX || !detail.dstX) {
                skipped++;
                continue;
            }
            const dist = distance(detail.srcX, detail.srcY, detail.dstX, detail.dstY);
            if (dist <= 0) {
                skipped++;
                continue;
            }
            const flightMin = (detail.arrival - detail.departure) / 60000;
            const minPerField = flightMin / dist;
            const cls = classifyByVelocity(minPerField);
            const label = `[${cls.label}|${minPerField.toFixed(2)}m/c]`;

            const ok = await setCommandLabel(inc.cmdId, label);
            if (ok) labeled++;
            log(`#${inc.cmdId}: ${minPerField.toFixed(2)} min/c → ${label} (${ok ? 'ok' : 'falhou'})`);
            await sleep(jitter());
        }

        STATE.taggerProgress = `done — ${labeled} etiquetados, ${skipped} pulados`;
        STATE.taggerRunning = false;
        updatePanel(null);
    }

    function injectPanel() {
        if (document.getElementById('tw-farm-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'tw-farm-panel';
        panel.innerHTML = `
<div style="position:fixed;top:120px;right:10px;z-index:99999;background:#f4e4bc;border:2px solid #603000;padding:8px;font-family:Verdana,Arial;font-size:11px;width:260px;box-shadow:2px 2px 8px rgba(0,0,0,0.4);border-radius:3px;">
  <div style="font-weight:bold;border-bottom:1px solid #603000;margin-bottom:6px;color:#603000;">TW Farm + Tagger — ThCarmo v0.2</div>

  <div style="font-weight:bold;color:#603000;margin-bottom:3px;">⚔ Farm</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-farm-start" style="flex:1;background:#1f7a1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">▶ START</button>
    <button id="tw-farm-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">■ STOP</button>
  </div>
  <div>Status: <b id="tw-farm-status">parado</b></div>
  <div>Enviados: <b id="tw-farm-counter">0</b> | Erros: <b id="tw-farm-errcounter">0</b></div>
  <div>Próximo: <span id="tw-farm-next">-</span></div>
  <div style="margin-top:3px;font-size:10px;color:#603000;display:flex;align-items:center;gap:4px;">
    <span>CL casa:</span> <input id="tw-farm-light" type="number" value="${STATE.troopsAtHome.light}" min="0" style="width:54px;font-size:10px;"/>
    <span>Spy:</span> <input id="tw-farm-spy" type="number" value="${STATE.troopsAtHome.spy}" min="0" style="width:54px;font-size:10px;"/>
    <button id="tw-farm-resync" style="background:#603000;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;">⟳</button>
  </div>
  <div style="margin-top:3px;font-size:10px;color:#603000;">
    Raio: <input id="tw-farm-radius" type="number" value="${CFG.radiusMax}" min="1" max="100" style="width:42px;font-size:10px;"/>
    Cooldown: <input id="tw-farm-cd" type="number" value="${CFG.cooldownMin}" min="1" max="600" style="width:42px;font-size:10px;"/>min
  </div>
  <div style="margin-top:3px;font-size:10px;color:#603000;">
    Jitter ms: <input id="tw-farm-jmin" type="number" value="${CFG.jitterMs[0]}" min="200" max="60000" style="width:54px;font-size:10px;"/>
    – <input id="tw-farm-jmax" type="number" value="${CFG.jitterMs[1]}" min="200" max="60000" style="width:54px;font-size:10px;"/>
  </div>
  <div style="font-size:9px;color:#888;">Último erro: <span id="tw-farm-lasterr">-</span></div>

  <hr style="border:none;border-top:1px solid #603000;margin:8px 0 6px;">

  <div style="font-weight:bold;color:#603000;margin-bottom:3px;">🛡 Incoming Tagger</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-tagger-run" style="flex:1;background:#1f4d7a;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">⟳ Analisar</button>
    <button id="tw-tagger-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">■ STOP</button>
  </div>
  <div style="font-size:10px;">Status: <span id="tw-tagger-status">ocioso</span></div>
</div>`;
        document.body.appendChild(panel);

        document.getElementById('tw-farm-start').onclick = () => {
            CFG.radiusMax = parseInt(document.getElementById('tw-farm-radius').value, 10) || 35;
            CFG.cooldownMin = parseInt(document.getElementById('tw-farm-cd').value, 10) || 30;
            const jmin = parseInt(document.getElementById('tw-farm-jmin').value, 10) || 3000;
            const jmax = parseInt(document.getElementById('tw-farm-jmax').value, 10) || 7000;
            CFG.jitterMs = [Math.min(jmin, jmax), Math.max(jmin, jmax)];
            STATE.troopsAtHome.light = parseInt(document.getElementById('tw-farm-light').value, 10) || 0;
            STATE.troopsAtHome.spy = parseInt(document.getElementById('tw-farm-spy').value, 10) || 0;
            STATE.running = true;
            farmLoop();
        };
        document.getElementById('tw-farm-stop').onclick = () => {
            STATE.running = false;
            updatePanel('STOP solicitado');
        };
        document.getElementById('tw-farm-resync').onclick = () => {
            const ok = syncTroopsAtHome();
            if (ok) {
                document.getElementById('tw-farm-light').value = STATE.troopsAtHome.light;
                document.getElementById('tw-farm-spy').value = STATE.troopsAtHome.spy;
                updatePanel(`resync: ${STATE.troopsAtHome.light} CL, ${STATE.troopsAtHome.spy} spy`);
            } else {
                updatePanel('resync falhou — ajuste manual');
            }
        };
        document.getElementById('tw-tagger-run').onclick = () => {
            if (STATE.taggerRunning) return;
            runTagger();
        };
        document.getElementById('tw-tagger-stop').onclick = () => {
            STATE.taggerRunning = false;
        };
    }

    function updatePanel(statusText) {
        const $ = id => document.getElementById(id);
        if ($('tw-farm-status') && statusText) $('tw-farm-status').textContent = statusText;
        if ($('tw-farm-counter')) $('tw-farm-counter').textContent = STATE.sent;
        if ($('tw-farm-errcounter')) $('tw-farm-errcounter').textContent = STATE.errors;
        if ($('tw-farm-next')) $('tw-farm-next').textContent = STATE.nextTarget;
        if ($('tw-farm-lasterr')) $('tw-farm-lasterr').textContent = STATE.lastError;
        if ($('tw-farm-light')) $('tw-farm-light').value = STATE.troopsAtHome.light;
        if ($('tw-farm-spy')) $('tw-farm-spy').value = STATE.troopsAtHome.spy;
        if ($('tw-tagger-status')) $('tw-tagger-status').textContent = STATE.taggerProgress;
    }

    async function waitForGameData(maxMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            if (getGameData()) return true;
            await sleep(200);
        }
        return false;
    }

    async function init() {
        console.log('[TW-FARM] init() v0.2.1 — URL:', location.href, 'readyState:', document.readyState);

        // Painel sempre aparece, com aviso se faltar contexto.
        try {
            injectPanel();
        } catch (e) {
            console.error('[TW-FARM] Falhou ao injetar painel:', e);
            return;
        }

        const gotData = await waitForGameData();
        const gd = getGameData();

        if (!gotData || !gd) {
            updatePanel('aguardando jogo carregar... (recarregue a página se persistir)');
            console.warn('[TW-FARM] game_data não populado após 8s. URL:', location.href);
            // Continua tentando em background
            const retry = setInterval(() => {
                if (getGameData()) {
                    clearInterval(retry);
                    const gd2 = getGameData();
                    log('game_data chegou (tardio). World:', gd2.world, 'Player:', gd2.player?.name);
                    syncTroopsAtHome();
                    updatePanel(isOnAmFarmScreen() ? 'pronto — clique START' : 'abra "Assistente de Saque"');
                }
            }, 1000);
            return;
        }

        log('Carregado. World:', gd.world, 'Player:', gd.player?.name, 'Village:', `(${gd.village?.x}|${gd.village?.y})`);
        syncTroopsAtHome();
        updatePanel(isOnAmFarmScreen() ? 'pronto — clique START' : 'abra "Assistente de Saque"');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
