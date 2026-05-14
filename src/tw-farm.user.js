// ==UserScript==
// @name         TW Farm + Tagger — ThCarmo
// @namespace    https://github.com/ThCarmo/tribal-wars-userscript
// @version      0.3.2
// @description  Farm (2L+1S, raio configurável) + Incoming Tagger (classifica tropa por velocidade)
// @author       Thiago Carmo
// @match        *://*.tribalwars.com.br/*
// @match        *://*.tribalwars.com.pt/*
// @match        *://*.die-staemme.de/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// @downloadURL  https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// ==/UserScript==

// ===== INJEÇÃO MAIN WORLD (v0.3.2) =====
// Tampermonkey 5.5 stable ignora @inject-into page. Workaround clássico:
// criar um <script> tag com o código real, anexar ao DOM, o browser executa
// no MAIN WORLD (mesmo contexto que o DevTools console). Funciona em qualquer TM.
console.log('[TW-FARM] stub carregado v0.3.2 — injetando main world script');
(function injectMainWorldScript() {
    function mainWorldScript() {
        'use strict';

    // ===== BANNER DE PROVA DE VIDA (v0.2.2) =====
    // Aparece NO TOPO da página antes de qualquer outra coisa.
    // Se este banner não aparecer, o script nem está rodando (problema de CSP/sandbox).
    // Se aparecer, o script roda — qualquer outra falha é local a uma função.
    try {
        const showBanner = () => {
            if (document.getElementById('tw-farm-banner-prova')) return;
            const b = document.createElement('div');
            b.id = 'tw-farm-banner-prova';
            b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#d40000;color:#fff;padding:12px;font:bold 14px Arial;text-align:center;border-bottom:3px solid #000;box-shadow:0 2px 10px rgba(0,0,0,0.6);';
            b.innerHTML = `✅ TW Farm userscript v0.3.2 ATIVO (Atacar Todos) — URL: ${location.href.slice(0, 80)} <span style="margin-left:20px;cursor:pointer;text-decoration:underline;" id="tw-farm-banner-close">[fechar]</span>`;
            (document.body || document.documentElement).insertAdjacentElement('afterbegin', b);
            document.getElementById('tw-farm-banner-close').onclick = () => b.remove();
        };
        if (document.body) {
            showBanner();
        } else {
            document.addEventListener('DOMContentLoaded', showBanner);
        }
        console.log('[TW-FARM] v0.3.2 carregado (script-tag bridge, main world) em', location.href);
    } catch (e) {
        console.error('[TW-FARM] banner-prova falhou:', e);
    }

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

    const LS_KEY = 'twFarmLastFarmByTarget';
    function lsGet(key, fallback) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
        catch (e) { return fallback; }
    }
    function lsSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    const STATE = {
        running: false,
        sent: 0,
        errors: 0,
        lastError: '-',
        nextTarget: '-',
        lastFarmByTarget: lsGet(LS_KEY, {}),
        troopsAtHome: { light: 0, spy: 0 },
        taggerRunning: false,
        taggerProgress: 'ocioso',
        // Map Scan (barbáros direto do /map/village.txt)
        mapScanRunning: false,
        mapScanProgress: 'ocioso',
        mapScanLast: null, // { count, atRadius, at, barbs[] }
    };

    const w = window;
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
        lsSet(LS_KEY, STATE.lastFarmByTarget);
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
            // botão A é o sinal mais confiável que é uma row de alvo (não header/footer)
            const buttonA =
                row.querySelector('a.farm_icon_a') ||
                row.querySelector('a[onclick*="farmA"]') ||
                row.querySelector('a[href*="from=A"]') ||
                row.querySelector('a.farm_icon[data-template="a"]') ||
                row.querySelector('.farm-icon-a');
            if (!buttonA) return;

            // targetId: tenta link info_village; fallback classe farm_village_<id> do botão A
            let targetId = null;
            const targetLink = row.querySelector('a[href*="info_village.php"], a[href*="screen=info_village"]');
            if (targetLink) {
                const m = targetLink.href.match(/[?&]id=(\d+)/);
                if (m) targetId = m[1];
            }
            if (!targetId) {
                const m = (buttonA.className || '').match(/farm_village_(\d+)/);
                if (m) targetId = m[1];
            }
            if (!targetId) return;

            // coordenadas: no BR142 não vêm no link, mas vêm em alguma <td> da linha.
            // Vasculha todas as células e o innerText completo.
            let tx = null, ty = null;
            const cells = row.querySelectorAll('td');
            for (const td of cells) {
                const m = (td.textContent || '').match(/\((\d{1,4})\|(\d{1,4})\)/);
                if (m) { tx = parseInt(m[1], 10); ty = parseInt(m[2], 10); break; }
            }
            if (tx == null) {
                const m = (row.innerText || row.textContent || '').match(/\((\d{1,4})\|(\d{1,4})\)/);
                if (m) { tx = parseInt(m[1], 10); ty = parseInt(m[2], 10); }
            }
            if (tx == null) return;

            const dist = distance(sourceX, sourceY, tx, ty);
            if (dist > CFG.radiusMax) return;

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

    // ============ MAP SCAN (lista barbáros do /map/village.txt) ============
    // Endpoint público do jogo, sem CSRF, sem captcha. CSV:
    //   id, name (URL-encoded), x, y, player_id, points, rank
    // player_id = 0 → barbáro.

    async function fetchBarbsInRadius(maxRadius) {
        const gd = getGameData();
        if (!gd || !gd.village) {
            log('Map scan: game_data.village indisponível');
            return [];
        }
        const ox = gd.village.x, oy = gd.village.y;
        log(`Map scan: buscando barbáros em raio ${maxRadius} de (${ox}|${oy})`);
        let text;
        try {
            const resp = await fetch('/map/village.txt', { credentials: 'same-origin' });
            if (!resp.ok) {
                log(`Map scan: HTTP ${resp.status} em /map/village.txt`);
                return [];
            }
            text = await resp.text();
        } catch (e) {
            log('Map scan: erro de rede:', e);
            return [];
        }

        const lines = text.split('\n');
        const barbs = [];
        for (const line of lines) {
            if (!line) continue;
            const parts = line.split(',');
            if (parts.length < 7) continue;
            const player = parseInt(parts[4], 10);
            if (player !== 0) continue;
            const x = parseInt(parts[2], 10);
            const y = parseInt(parts[3], 10);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const dx = x - ox, dy = y - oy;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > maxRadius) continue;
            let name;
            try { name = decodeURIComponent(parts[1].replace(/\+/g, ' ')); }
            catch (e) { name = parts[1]; }
            barbs.push({
                id: parts[0],
                name,
                x, y,
                points: parseInt(parts[5], 10) || 0,
                dist
            });
        }
        barbs.sort((a, b) => a.dist - b.dist);
        log(`Map scan: ${barbs.length} barbáros no raio ${maxRadius}`);
        return barbs;
    }

    // ============ ENVIO VIA PRAÇA DE REUNIÕES ============
    // Flow padrão TW:
    //   Step 1: GET screen=place&target=ID → HTML com form (CSRF token, hidden fields)
    //   Step 2: POST try=confirm com light/spy preenchidos → HTML "Confirmar ataque"
    //   Step 3: POST action=command com tudo do form de confirmação → ataque enviado
    // Retorna { ok: true } ou { ok: false, error: 'msg' }

    async function sendFarmViaPlace(targetId, lightCount, spyCount, dryRun = false) {
        const gd = getGameData();
        if (!gd || !gd.village || !gd.village.id) {
            return { ok: false, error: 'game_data.village indisponível' };
        }
        const sourceId = gd.village.id;
        const csrf = gd.csrf || w.csrf_token || (gd.player && gd.player.sitter_id);
        const parser = new DOMParser();

        // Step 1: GET form da Praça com target preenchido
        const url1 = `/game.php?village=${sourceId}&screen=place&target=${targetId}`;
        let r1;
        try {
            r1 = await fetch(url1, { credentials: 'same-origin' });
        } catch (e) { return { ok: false, error: 'rede step1: ' + e.message }; }
        if (!r1.ok) return { ok: false, error: `HTTP ${r1.status} step1` };
        const html1 = await r1.text();
        const doc1 = parser.parseFromString(html1, 'text/html');

        // valida que estamos na tela certa (sem erro de bloqueio)
        const errBox1 = doc1.querySelector('.error_box, .login_error');
        if (errBox1) return { ok: false, error: 'step1 erro: ' + errBox1.textContent.trim().slice(0,150) };

        const form1 = doc1.querySelector('form#command-data-form, form[action*="screen=place"], form[name="form_command"]');
        if (!form1) return { ok: false, error: 'step1 form não encontrado (HTML inesperado)' };

        // Pegar h (CSRF) do form ou do gd
        let h = csrf;
        const hInput1 = form1.querySelector('input[name="h"]');
        if (hInput1 && hInput1.value) h = hInput1.value;
        if (!h) return { ok: false, error: 'CSRF token não encontrado' };

        // Construir body com hidden fields existentes + tropas
        const fd2 = new FormData();
        form1.querySelectorAll('input[type=hidden]').forEach(inp => {
            if (inp.name) fd2.append(inp.name, inp.value || '');
        });
        // Coords do alvo (pegar do scan se disponível)
        const target = (STATE.mapScanLast && STATE.mapScanLast.barbs)
            ? STATE.mapScanLast.barbs.find(b => String(b.id) === String(targetId))
            : null;
        if (target) { fd2.set('x', target.x); fd2.set('y', target.y); }
        fd2.set('target', targetId);

        // Zera todas as unidades, depois preenche light/spy
        const allUnits = ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','militia','snob'];
        for (const u of allUnits) fd2.set(u, '0');
        fd2.set('light', String(lightCount));
        fd2.set('spy', String(spyCount));
        fd2.set('attack', 'l'); // "Atacar"
        fd2.set('h', h);

        if (dryRun) {
            const debugBody = {};
            for (const [k, v] of fd2.entries()) debugBody[k] = v;
            return { ok: true, dryRun: true, step1Url: url1, csrf: h, body: debugBody };
        }

        // Step 2: POST try=confirm
        const url2 = `/game.php?village=${sourceId}&screen=place&try=confirm&h=${h}`;
        let r2;
        try {
            r2 = await fetch(url2, { method: 'POST', body: fd2, credentials: 'same-origin' });
        } catch (e) { return { ok: false, error: 'rede step2: ' + e.message }; }
        if (!r2.ok) return { ok: false, error: `HTTP ${r2.status} step2` };
        const html2 = await r2.text();
        const doc2 = parser.parseFromString(html2, 'text/html');

        const errBox2 = doc2.querySelector('.error_box, .autocomplete-suggestions .error');
        if (errBox2) return { ok: false, error: 'step2 erro: ' + errBox2.textContent.trim().slice(0,150) };

        const form2 = doc2.querySelector('form#command-data-form, form[id*="command"], form[action*="action=command"]');
        if (!form2) return { ok: false, error: 'step2 form de confirmação não retornou' };

        // Step 3: extrai tudo do form de confirmação + manda action=command
        const fd3 = new FormData();
        form2.querySelectorAll('input').forEach(inp => {
            if (inp.name && inp.type !== 'submit') fd3.append(inp.name, inp.value || '');
        });
        fd3.set('attack', 'true');

        const action3 = form2.getAttribute('action') || `/game.php?village=${sourceId}&screen=place&action=command&h=${h}`;
        const url3 = action3.startsWith('http') ? action3 : action3;
        let r3;
        try {
            r3 = await fetch(url3, { method: 'POST', body: fd3, credentials: 'same-origin' });
        } catch (e) { return { ok: false, error: 'rede step3: ' + e.message }; }
        if (!r3.ok) return { ok: false, error: `HTTP ${r3.status} step3` };
        const html3 = await r3.text();

        if (html3.includes('command_id') || html3.includes('screen=info_command') || html3.includes('overview_villages') || /comando.*sucesso/i.test(html3)) {
            return { ok: true };
        }
        const doc3 = parser.parseFromString(html3, 'text/html');
        const err3 = doc3.querySelector('.error_box, .error');
        if (err3) return { ok: false, error: 'step3 erro: ' + err3.textContent.trim().slice(0,150) };

        // sem confirmação clara — devolve raw pra inspecionar
        return { ok: false, error: 'step3 resposta ambígua', rawSample: html3.slice(0, 300) };
    }

    // ============ ATACAR TODOS (loop em cima do scan) ============
    // Itera barbáros do último scan, dispara 2L+1S em cada via sendFarmViaPlace().
    // Reaproveita guard-rails do farm: cooldown, CL<2, captcha, erro do servidor.

    async function mapScanFarmAll() {
        const barbs = STATE.mapScanLast && STATE.mapScanLast.barbs;
        if (!barbs || barbs.length === 0) {
            STATE.mapScanProgress = 'rode 🔍 Buscar Barbs primeiro';
            updatePanel(null);
            return;
        }

        STATE.mapScanRunning = true;
        let attempted = 0, sent = 0, skippedCooldown = 0, errors = 0;
        log(`Map farm: iniciando sobre ${barbs.length} alvos`);

        for (const b of barbs) {
            if (!STATE.mapScanRunning) {
                STATE.lastError = 'parado manualmente';
                break;
            }
            if (captchaActive()) {
                STATE.lastError = 'captcha detectado, parando';
                STATE.mapScanRunning = false;
                break;
            }
            if (STATE.troopsAtHome.light < 2 || STATE.troopsAtHome.spy < 1) {
                STATE.lastError = `estoque baixo: ${STATE.troopsAtHome.light}CL / ${STATE.troopsAtHome.spy}spy`;
                STATE.mapScanRunning = false;
                break;
            }
            if (isOnCooldown(b.id)) {
                skippedCooldown++;
                continue;
            }

            attempted++;
            STATE.nextTarget = `(${b.x}|${b.y}) ${b.dist.toFixed(1)}c`;
            STATE.mapScanProgress = `${sent} enviados / ${attempted} tentativas, alvo ${STATE.nextTarget}`;
            updatePanel(STATE.mapScanProgress);

            const res = await sendFarmViaPlace(b.id, 2, 1, false);

            if (res.ok) {
                sent++;
                STATE.sent++;
                STATE.troopsAtHome.light -= 2;
                STATE.troopsAtHome.spy -= 1;
                STATE.lastFarmByTarget[b.id] = serverTime();
                lsSet(LS_KEY, STATE.lastFarmByTarget);
                log(`Map farm #${sent}: (${b.x}|${b.y}) ok, estoque ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy`);
            } else {
                errors++;
                STATE.errors++;
                STATE.lastError = res.error || 'erro desconhecido';
                log(`Map farm erro em (${b.x}|${b.y}) id ${b.id}:`, res.error);
                if (/captcha|bot|provis|proteç|protect/i.test(res.error || '')) {
                    STATE.lastError = 'servidor sinalizou bot/captcha — parando';
                    STATE.mapScanRunning = false;
                    break;
                }
                if (errors >= 5 && sent === 0) {
                    STATE.lastError = '5 erros sem 1 sucesso — abortando pra investigar';
                    STATE.mapScanRunning = false;
                    break;
                }
            }

            await sleep(jitter());
        }

        STATE.mapScanRunning = false;
        STATE.mapScanProgress = `parado: ${sent} enviados, ${errors} erros, ${skippedCooldown} em cooldown`;
        updatePanel(STATE.mapScanProgress);
        log('Map farm finalizado:', STATE.mapScanProgress);
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

  <div style="font-weight:bold;color:#603000;margin-bottom:3px;">🗺 Map Scan (barbáros)</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-map-scan" style="flex:1;background:#603000;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">🔍 Buscar Barbs no raio</button>
  </div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-map-dryrun" style="flex:1;background:#a07000;color:white;border:none;padding:4px;cursor:pointer;font-size:10px;border-radius:2px;">🧪 Testar 1 (dry-run)</button>
    <button id="tw-map-real1" style="flex:1;background:#7a1f1f;color:white;border:none;padding:4px;cursor:pointer;font-size:10px;border-radius:2px;">🎯 Atacar 1 (REAL)</button>
  </div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-map-attack-all" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">💥 ATACAR TODOS</button>
    <button id="tw-map-stop-all" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">■ PARAR</button>
  </div>
  <div style="font-size:10px;">Status: <span id="tw-map-status">ocioso</span></div>
  <div style="font-size:9px;color:#888;">Atacar Todos itera sobre o scan, 2L+1S em cada, jitter 3-7s, para em CL&lt;2 / captcha / erro.</div>

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

        document.getElementById('tw-map-dryrun').onclick = async () => {
            const barbs = STATE.mapScanLast && STATE.mapScanLast.barbs;
            if (!barbs || barbs.length === 0) {
                document.getElementById('tw-map-status').textContent = 'rode o Buscar Barbs primeiro';
                return;
            }
            const t = barbs[0];
            document.getElementById('tw-map-status').textContent = `dry-run em (${t.x}|${t.y}) id ${t.id}...`;
            const res = await sendFarmViaPlace(t.id, 2, 1, true);
            console.log('%c[TW-FARM] DRY-RUN resultado:', 'color:#a07000;font-weight:bold', res);
            if (res.ok) {
                document.getElementById('tw-map-status').textContent = `dry-run ok. body em window.TW_FARM_LAST_DRYRUN`;
                w.TW_FARM_LAST_DRYRUN = res;
            } else {
                document.getElementById('tw-map-status').textContent = `dry-run FALHOU: ${res.error}`;
            }
        };

        document.getElementById('tw-map-attack-all').onclick = async () => {
            if (STATE.mapScanRunning) {
                document.getElementById('tw-map-status').textContent = 'já está rodando';
                return;
            }
            const barbs = STATE.mapScanLast && STATE.mapScanLast.barbs;
            if (!barbs || barbs.length === 0) {
                document.getElementById('tw-map-status').textContent = 'rode 🔍 Buscar Barbs primeiro';
                return;
            }
            // Aplica configs atuais do painel
            CFG.radiusMax = parseInt(document.getElementById('tw-farm-radius').value, 10) || 35;
            CFG.cooldownMin = parseInt(document.getElementById('tw-farm-cd').value, 10) || 30;
            const jmin = parseInt(document.getElementById('tw-farm-jmin').value, 10) || 3000;
            const jmax = parseInt(document.getElementById('tw-farm-jmax').value, 10) || 7000;
            CFG.jitterMs = [Math.min(jmin, jmax), Math.max(jmin, jmax)];
            STATE.troopsAtHome.light = parseInt(document.getElementById('tw-farm-light').value, 10) || 0;
            STATE.troopsAtHome.spy = parseInt(document.getElementById('tw-farm-spy').value, 10) || 0;

            const maxAtaques = Math.floor(Math.min(STATE.troopsAtHome.light / 2, STATE.troopsAtHome.spy));
            const confirmAll = window.confirm(
                `ATACAR TODOS:\n\n` +
                `${barbs.length} barbáros no scan (raio ${STATE.mapScanLast.atRadius})\n` +
                `Estoque: ${STATE.troopsAtHome.light}CL / ${STATE.troopsAtHome.spy}spy\n` +
                `Máx ataques possíveis: ${maxAtaques}\n` +
                `Jitter: ${CFG.jitterMs[0]}-${CFG.jitterMs[1]}ms\n` +
                `Cooldown: ${CFG.cooldownMin}min\n\n` +
                `Para em CL<2, captcha, ou 5 erros sem 1 sucesso. Confirma?`
            );
            if (!confirmAll) {
                document.getElementById('tw-map-status').textContent = 'cancelado pelo operador';
                return;
            }
            mapScanFarmAll();
        };
        document.getElementById('tw-map-stop-all').onclick = () => {
            STATE.mapScanRunning = false;
            document.getElementById('tw-map-status').textContent = 'parando após farm atual...';
        };

        document.getElementById('tw-map-real1').onclick = async () => {
            const barbs = STATE.mapScanLast && STATE.mapScanLast.barbs;
            if (!barbs || barbs.length === 0) {
                document.getElementById('tw-map-status').textContent = 'rode o Buscar Barbs primeiro';
                return;
            }
            if (STATE.troopsAtHome.light < 2) {
                document.getElementById('tw-map-status').textContent = `precisa 2 CL em casa (tem ${STATE.troopsAtHome.light}). Use RESYNC ou ajuste manual.`;
                return;
            }
            const t = barbs[0];
            const confirm1 = window.confirm(`ATAQUE REAL: 2L+1S → (${t.x}|${t.y}) [${t.name}], dist ${t.dist.toFixed(1)}c. Confirma?`);
            if (!confirm1) {
                document.getElementById('tw-map-status').textContent = 'cancelado pelo operador';
                return;
            }
            document.getElementById('tw-map-status').textContent = `enviando 2L+1S → (${t.x}|${t.y})...`;
            const res = await sendFarmViaPlace(t.id, 2, 1, false);
            console.log('%c[TW-FARM] REAL resultado:', 'color:#7a1f1f;font-weight:bold', res);
            if (res.ok) {
                STATE.troopsAtHome.light -= 2;
                STATE.troopsAtHome.spy -= 1;
                STATE.lastFarmByTarget[t.id] = serverTime();
                lsSet(LS_KEY, STATE.lastFarmByTarget);
                document.getElementById('tw-map-status').textContent = `ataque enviado em (${t.x}|${t.y}). Confira no Comandos do jogo.`;
                updatePanel(null);
            } else {
                document.getElementById('tw-map-status').textContent = `FALHOU: ${res.error}`;
            }
        };

        document.getElementById('tw-map-scan').onclick = async () => {
            if (STATE.mapScanRunning) return;
            STATE.mapScanRunning = true;
            const r = parseInt(document.getElementById('tw-farm-radius').value, 10) || 35;
            const $status = document.getElementById('tw-map-status');
            $status.textContent = `buscando em raio ${r}...`;
            try {
                const barbs = await fetchBarbsInRadius(r);
                STATE.mapScanLast = { count: barbs.length, atRadius: r, at: serverTime(), barbs };
                w.TW_FARM_LAST_SCAN = barbs;
                $status.textContent = `${barbs.length} barbáros no raio ${r}. Console F12 mostra os 30 mais próximos.`;
                console.log(`%c[TW-FARM] Map Scan: ${barbs.length} barbáros no raio ${r}`, 'color:#603000;font-weight:bold');
                console.table(barbs.slice(0, 30).map(b => ({
                    id: b.id, coord: `(${b.x}|${b.y})`, dist: b.dist.toFixed(1), pts: b.points, name: b.name
                })));
                console.log('Lista completa em window.TW_FARM_LAST_SCAN');
            } catch (e) {
                $status.textContent = `erro: ${e.message || e}`;
                log('Map scan exceção:', e);
            } finally {
                STATE.mapScanRunning = false;
            }
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
    }

    const code = '(' + mainWorldScript.toString() + ')();';
    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    console.log('[TW-FARM] script tag injetado, total bytes:', code.length);
})();
