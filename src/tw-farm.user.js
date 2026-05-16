// ==UserScript==
// @name         TW Farm + Build + Recruit — ThCarmo
// @namespace    https://github.com/ThCarmo/tribal-wars-userscript
// @version      0.7.0
// @description  Farm (2L+1S, raio configurável) + Build Queue (multi-vila) + Recruit + Incoming Tagger
// @author       Thiago Carmo
// @match        *://*.tribalwars.com.br/*
// @match        *://*.tribalwars.com.pt/*
// @match        *://*.die-staemme.de/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// @downloadURL  https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js
// ==/UserScript==

// ===== INJEÇÃO MAIN WORLD (v0.3.3) =====
// Tampermonkey 5.5 stable ignora @inject-into page. Workaround clássico:
// criar um <script> tag com o código real, anexar ao DOM, o browser executa
// no MAIN WORLD (mesmo contexto que o DevTools console). Funciona em qualquer TM.
console.log('[TW-FARM] stub carregado v0.7.0 — injetando main world script');
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
            b.innerHTML = `✅ TW Farm + Build + Research + Recruit v0.7.0 ATIVO — painéis: Farm à direita, Build/Research à esquerda <span style="margin-left:20px;cursor:pointer;text-decoration:underline;" id="tw-farm-banner-close">[fechar]</span>`;
            (document.body || document.documentElement).insertAdjacentElement('afterbegin', b);
            document.getElementById('tw-farm-banner-close').onclick = () => b.remove();
        };
        if (document.body) {
            showBanner();
        } else {
            document.addEventListener('DOMContentLoaded', showBanner);
        }
        console.log('[TW-FARM] v0.7.0 carregado (script-tag bridge, main world) em', location.href);
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

        // Auto-resync: se inputs do painel estão zerados, tenta ler do jogo antes de barrar.
        if (STATE.troopsAtHome.light < 2 || STATE.troopsAtHome.spy < 1) {
            log('Map farm: estoque zerado nos inputs, tentando syncTroopsAtHome()...');
            syncTroopsAtHome();
            const $l = document.getElementById('tw-farm-light');
            const $s = document.getElementById('tw-farm-spy');
            if ($l) $l.value = STATE.troopsAtHome.light;
            if ($s) $s.value = STATE.troopsAtHome.spy;
        }
        if (STATE.troopsAtHome.light < 2 || STATE.troopsAtHome.spy < 1) {
            STATE.mapScanProgress = `estoque ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy < min(2,1). Preencha os campos manualmente e tente de novo.`;
            updatePanel(STATE.mapScanProgress);
            log('Map farm abortado:', STATE.mapScanProgress);
            return;
        }

        STATE.mapScanRunning = true;
        let attempted = 0, sent = 0, skippedCooldown = 0, errors = 0;
        log(`Map farm: iniciando sobre ${barbs.length} alvos. Estoque: ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy`);

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
        STATE.mapScanProgress = `parado: ${sent} enviados, ${errors} erros, ${skippedCooldown} em cooldown. Razão: ${STATE.lastError || 'fim da lista'}`;
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

    // =====================================================================
    // ========= MÓDULO BUILD + RECRUIT (escopo isolado via IIFE) ==========
    // =====================================================================
    // Adicionado em v0.5.0 — construir + recrutar em todas as vilas pra mundo
    // speed onde farm não compensa. Coexiste com o farm acima sem colidir.
    // Painel: à esquerda. Verde. Independente do painel laranja do farm.

    (function buildRecruitModule() {
        'use strict';

        const wB = window;
        const sleepB = ms => new Promise(r => setTimeout(r, ms));

        const BCFG = {
            cycleMs: 60000,             // intervalo entre passadas completas (s). Mundo speed: 60s. Mundo normal: 300-600s.
            jitterMs: [1000, 3000],     // jitter entre POSTs
            perVillagePauseMs: [1500, 3500],  // jitter entre vilas (ajustado pra escala 100+)
            queueSlots: 2,
            recruitResourcePct: 0.85,
            recruitMaxPerUnit: 200,
            researchEnabled: true,
            researchAttempts: 5,
            coinsPerCycle: 1,
            maxNobles: 50,
            // === Especialização de vilas (v0.7.0) ===
            // Quantas vilas serão NOBLE (geradoras de nobres). Resto = OFF (full heavy).
            // Default: primeiras N da lista. Pode override manual no painel via ✎ Roles.
            nobleVillageCount: 5,
            debugLog: true,
        };

        // ===== ROLE CONFIGS (template, mix de tropa, whitelist de pesquisa) =====
        // OFF = vila de ataque pura, só heavy. Sem barracks, sem garage, sem academia.
        //       Foco: stable + smith + recursos máximos pra fazer heavy em massa.
        // NOBLE = vila geradora de nobre. Academia + market alto pra cunhar.
        //         Escolta mínima de heavy + spy.

        const TEMPLATE_OFF = [
            // Base
            ['main', 3], ['wood', 5], ['stone', 5], ['iron', 5],
            ['farm', 3], ['storage', 3],
            // Habilitar pesquisa de heavy
            ['main', 5], ['wood', 10], ['stone', 10], ['iron', 10],
            ['farm', 7], ['storage', 5], ['smith', 1], ['stable', 1],
            // Escalando stable + smith pra heavy
            ['main', 10], ['smith', 5], ['stable', 5],
            ['wood', 15], ['stone', 15], ['iron', 15],
            ['farm', 15], ['storage', 10], ['hide', 5],
            // Heavy lvl 2 disponível
            ['smith', 10], ['stable', 10],
            ['wood', 20], ['stone', 20], ['iron', 20],
            ['farm', 20], ['storage', 15],
            // Heavy lvl 3 max
            ['smith', 15], ['stable', 15],
            ['smith', 20], ['stable', 20],
            // Recursos max
            ['main', 15], ['wood', 25], ['stone', 25], ['iron', 25],
            ['farm', 25], ['storage', 20],
            ['wood', 30], ['stone', 30], ['iron', 30],
            ['farm', 30], ['storage', 30],
            // Defesa final
            ['wall', 10], ['wall', 20],
        ];

        const TEMPLATE_NOBLE = [
            // Base
            ['main', 3], ['wood', 5], ['stone', 5], ['iron', 5],
            ['farm', 3], ['storage', 3],
            // Cedo: market + smith + stable pra escolta
            ['main', 5], ['wood', 10], ['stone', 10], ['iron', 10],
            ['farm', 7], ['storage', 5],
            ['smith', 1], ['market', 1], ['stable', 1],
            // Academia o quanto antes
            ['main', 10], ['market', 5],
            ['wood', 15], ['stone', 15], ['iron', 15],
            ['farm', 15], ['storage', 10],
            ['main', 15], ['market', 10], ['snob', 1],   // 1ª academia
            // Escalando recursos pra cunhar
            ['wood', 20], ['stone', 20], ['iron', 20],
            ['farm', 20], ['storage', 20],
            ['snob', 2],                                  // 2 nobres simultâneos
            ['market', 15], ['smith', 5], ['stable', 5],
            ['wood', 25], ['stone', 25], ['iron', 25],
            ['farm', 25], ['storage', 25],
            ['snob', 3],                                  // 3 nobres simultâneos
            ['market', 20], ['smith', 10], ['stable', 10],
            // Recursos max pra continuar cunhando
            ['wood', 30], ['stone', 30], ['iron', 30],
            ['farm', 30], ['storage', 30],
            ['wall', 10], ['wall', 20],
        ];

        const MIX_OFF = {
            // 100% heavy. Spy 0 pra não desperdiçar pop.
            heavy: 1.0,
        };

        const MIX_NOBLE = {
            // Escolta mínima pra defender as moedas + spy pra info
            heavy: 0.30,
            spy:   0.05,
        };

        // Whitelist de pesquisa por role — pra smith não desperdiçar recursos
        // pesquisando spear/sword/axe/light se ele nunca vai recrutar essas.
        const RESEARCH_WHITELIST = {
            OFF:   ['heavy', 'spy'],
            NOBLE: ['heavy', 'spy', 'snob'],
        };

        const jitterB = (range = BCFG.jitterMs) =>
            Math.floor(range[0] + Math.random() * (range[1] - range[0]));

        const LS_ROLES_OVERRIDE = 'twBuildRolesOverride';  // { villageId: 'OFF'|'NOBLE' }
        const LS_NOBLE_COUNT = 'twBuildNobleCount';
        const LS_TEMPLATES_CUSTOM = 'twBuildTemplatesCustom';  // { OFF: [...], NOBLE: [...] }
        const LS_MIXES_CUSTOM = 'twBuildMixesCustom';          // { OFF: {...}, NOBLE: {...} }

        const lsGetB = (key, fallback) => {
            try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
            catch (e) { return fallback; }
        };
        const lsSetB = (key, value) => {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
        };

        // Carrega customizações persistidas (overrides do default)
        const customTpl = lsGetB(LS_TEMPLATES_CUSTOM, {});
        const customMix = lsGetB(LS_MIXES_CUSTOM, {});

        const BSTATE = {
            buildRunning: false,
            researchRunning: false,
            recruitRunning: false,
            coinRunning: false,
            snobRunning: false,
            cycleCount: 0,
            lastCycleAt: null,
            log: [],
            // === Especialização por role (v0.7.0) ===
            templates: {
                OFF:   customTpl.OFF   || TEMPLATE_OFF,
                NOBLE: customTpl.NOBLE || TEMPLATE_NOBLE,
            },
            mixes: {
                OFF:   customMix.OFF   || MIX_OFF,
                NOBLE: customMix.NOBLE || MIX_NOBLE,
            },
            nobleCount: lsGetB(LS_NOBLE_COUNT, BCFG.nobleVillageCount),
            rolesOverride: lsGetB(LS_ROLES_OVERRIDE, {}),  // { villageId: 'OFF'|'NOBLE' }
            villageStatuses: {},
            villagesCache: null,
            villagesCacheAt: 0,
        };

        const nowStrB = () => new Date().toTimeString().slice(0, 8);

        function logB(...args) {
            if (BCFG.debugLog) console.log('%c[TW-BUILD]', 'color:#1f5d1f;font-weight:bold', ...args);
            const line = `${nowStrB()} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
            BSTATE.log.unshift(line);
            if (BSTATE.log.length > 30) BSTATE.log.length = 30;
            updateLogPanelB();
        }

        const getGameDataB = () => wB.game_data || null;

        function villagesFromGameDataB() {
            const gd = getGameDataB();
            if (!gd) return [];
            if (Array.isArray(gd.villages)) {
                return gd.villages.map(v => ({
                    id: String(v.id), name: v.name || `Vila ${v.id}`, x: v.x, y: v.y,
                }));
            }
            if (gd.player && gd.player.villages) {
                const pv = gd.player.villages;
                if (Array.isArray(pv)) {
                    return pv.map(v => ({
                        id: String(v.id || v), name: v.name || `Vila ${v.id || v}`, x: v.x, y: v.y,
                    }));
                }
                return Object.entries(pv).map(([id, v]) => ({
                    id: String(id), name: v.name || `Vila ${id}`, x: v.x, y: v.y,
                }));
            }
            if (gd.village && gd.village.id) {
                return [{ id: String(gd.village.id), name: gd.village.name || 'Vila ativa', x: gd.village.x, y: gd.village.y }];
            }
            return [];
        }

        async function fetchVillagesFromOverviewB() {
            // Página overview_villages SEMPRE lista todas as vilas do jogador.
            // Usa essa fonte quando game_data trouxer só a vila ativa.
            // Tenta múltiplas URLs porque modes variam entre mundos.
            const urls = [
                '/game.php?screen=overview_villages&mode=combined',
                '/game.php?screen=overview_villages&mode=prod',
                '/game.php?screen=overview_villages',
            ];
            for (const url of urls) {
                try {
                    const resp = await fetch(url, { credentials: 'same-origin' });
                    if (!resp.ok) {
                        logB(`overview ${url} retornou HTTP ${resp.status}`);
                        continue;
                    }
                    const html = await resp.text();
                    const doc = new DOMParser().parseFromString(html, 'text/html');

                    const seen = new Set();
                    const villages = [];

                    // Estratégia ampla: catar TODA <a href*="village=NNN"> da página
                    // que tenha coord em alguma <td> da mesma <tr>.
                    const links = doc.querySelectorAll('a[href*="village="]');
                    links.forEach(link => {
                        const idMatch = link.getAttribute('href').match(/[?&]village=(\d+)/);
                        if (!idMatch) return;
                        const id = idMatch[1];
                        if (seen.has(id)) return;
                        // só pega links dentro de tabelas (evita menus/sidebar)
                        const row = link.closest('tr');
                        if (!row) return;
                        const rowText = row.textContent || row.innerText || '';
                        const coordMatch = rowText.match(/\((\d{1,4})\|(\d{1,4})\)/);
                        if (!coordMatch) return;
                        const x = parseInt(coordMatch[1], 10);
                        const y = parseInt(coordMatch[2], 10);
                        const name = (link.textContent || `Vila ${id}`).trim().slice(0, 30);
                        seen.add(id);
                        villages.push({ id, name, x, y });
                    });

                    if (villages.length > 0) {
                        logB(`overview ${url} → ${villages.length} vilas`);
                        return villages;
                    }
                    logB(`overview ${url} retornou 200 mas 0 vilas (DOM diferente?)`);
                } catch (e) {
                    logB(`overview ${url} crashou: ${e.message}`);
                }
            }
            return [];
        }

        async function getAllVillagesB(forceRefresh = false) {
            // Cache 5min (não muda durante a sessão normalmente)
            if (!forceRefresh && BSTATE.villagesCache && (Date.now() - BSTATE.villagesCacheAt) < 5 * 60 * 1000) {
                return BSTATE.villagesCache;
            }
            const fromGd = villagesFromGameDataB();
            // Se game_data já trouxe muitas vilas, confia. Senão, busca via overview.
            if (fromGd.length >= 5) {
                BSTATE.villagesCache = fromGd;
                BSTATE.villagesCacheAt = Date.now();
                return fromGd;
            }
            logB(`game_data trouxe ${fromGd.length} vila(s) — buscando lista completa via overview_villages...`);
            const fromOverview = await fetchVillagesFromOverviewB();
            const final = fromOverview.length >= fromGd.length ? fromOverview : fromGd;
            BSTATE.villagesCache = final;
            BSTATE.villagesCacheAt = Date.now();
            logB(`Lista completa: ${final.length} vilas (overview: ${fromOverview.length}, game_data: ${fromGd.length})`);
            return final;
        }

        // Versão síncrona pra UI — usa cache, retorna [] se não tiver
        function getAllVillagesSyncB() {
            if (BSTATE.villagesCache) return BSTATE.villagesCache;
            return villagesFromGameDataB();
        }

        // === Roles ===
        // Override manual: BSTATE.rolesOverride[villageId] = 'OFF' ou 'NOBLE'
        // Default: as primeiras BSTATE.nobleCount vilas (na ordem que vieram) = NOBLE.
        function getVillageRoleB(villageId, allVillages) {
            const override = BSTATE.rolesOverride[String(villageId)];
            if (override === 'OFF' || override === 'NOBLE') return override;
            if (!allVillages) allVillages = getAllVillagesSyncB();
            const idx = allVillages.findIndex(v => String(v.id) === String(villageId));
            if (idx === -1) return 'OFF';  // fallback
            return idx < BSTATE.nobleCount ? 'NOBLE' : 'OFF';
        }

        function getTemplateForRoleB(role) {
            return BSTATE.templates[role] || BSTATE.templates.OFF;
        }
        function getMixForRoleB(role) {
            return BSTATE.mixes[role] || BSTATE.mixes.OFF;
        }
        function getResearchWhitelistForRoleB(role) {
            return RESEARCH_WHITELIST[role] || RESEARCH_WHITELIST.OFF;
        }

        async function fetchMainScreenB(villageId) {
            const url = `/game.php?village=${villageId}&screen=main`;
            const resp = await fetch(url, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} main`);
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return { html, doc };
        }

        function parseResourcesB(doc) {
            const num = sel => {
                const el = doc.querySelector(sel);
                if (!el) return null;
                const n = parseInt((el.textContent || el.getAttribute('value') || '').replace(/[^\d]/g, ''), 10);
                return Number.isFinite(n) ? n : null;
            };
            return {
                wood:    num('#wood') ?? num('#wood_value') ?? 0,
                stone:   num('#stone') ?? num('#stone_value') ?? 0,
                iron:    num('#iron') ?? num('#iron_value') ?? 0,
                popUsed: num('#pop_current_label') ?? 0,
                popMax:  num('#pop_max_label') ?? 0,
                storageMax: num('#storage') ?? 0,
            };
        }

        function parseCsrfB(doc) {
            const body = doc.querySelector('body');
            if (body && body.getAttribute('data-csrf')) return body.getAttribute('data-csrf');
            const inp = doc.querySelector('input[name="h"]');
            if (inp && inp.value) return inp.value;
            const m = doc.documentElement.outerHTML.match(/csrf_token\s*[:=]\s*['"]([a-f0-9]+)['"]/i);
            if (m) return m[1];
            return null;
        }

        function parseCurrentLevelsB(doc) {
            const out = {};
            const rows = doc.querySelectorAll('tr[id^="main_buildrow_"]');
            rows.forEach(row => {
                const id = row.id.replace('main_buildrow_', '');
                let level = 0;
                const nextLevelEl = row.querySelector('[data-level-next]');
                if (nextLevelEl) {
                    const n = parseInt(nextLevelEl.getAttribute('data-level-next'), 10);
                    if (Number.isFinite(n)) level = Math.max(0, n - 1);
                }
                if (level === 0) {
                    const spanLvl = row.querySelector('.level, span.level-display, td.lit-item');
                    if (spanLvl) {
                        const m = (spanLvl.textContent || '').match(/(\d+)/);
                        if (m) level = parseInt(m[1], 10);
                    }
                }
                if (level === 0) {
                    const m = (row.innerText || row.textContent || '').match(/N[íi]vel\s+(\d+)/i);
                    if (m) level = parseInt(m[1], 10);
                }
                out[id] = level;
            });
            return out;
        }

        function parseBuildQueueB(doc) {
            const queue = [];
            const rows = doc.querySelectorAll('#buildqueue tbody tr, table.buildorder_table tbody tr, #build_queue tbody tr');
            rows.forEach(row => {
                const text = (row.innerText || row.textContent || '').trim();
                if (!text) return;
                if (/aguard|cancel|tempo|^Constru/i.test(text) && !/N[íi]vel\s+\d/i.test(text)) return;
                const ptMap = {
                    'Sede da Aldeia': 'main', 'Sede': 'main',
                    'Quartel': 'barracks',
                    'Est[áa]bulo': 'stable',
                    'Oficina': 'garage',
                    'Igreja': 'church',
                    'Academia': 'snob',
                    'Ferreiro': 'smith',
                    'Pra[çc]a de Reuni[õo]es': 'place', 'Praça': 'place',
                    'Mercado': 'market',
                    'Bosque': 'wood', 'Madeireiro': 'wood',
                    'Poço de Argila': 'stone', 'Po[çc]o': 'stone',
                    'Mina de Ferro': 'iron',
                    'Fazenda': 'farm',
                    'Armaz[ée]m': 'storage',
                    'Esconderijo': 'hide',
                    'Muralha': 'wall',
                    'Torre de Vigia': 'watchtower',
                    'Est[áa]tua': 'statue',
                };
                let building = null;
                for (const [pattern, id] of Object.entries(ptMap)) {
                    if (new RegExp(pattern, 'i').test(text)) { building = id; break; }
                }
                const lvlMatch = text.match(/N[íi]vel\s+(\d+)/i);
                if (building && lvlMatch) {
                    queue.push({ building, targetLevel: parseInt(lvlMatch[1], 10) });
                }
            });
            return queue;
        }

        function pickNextBuildB(template, current, queue) {
            const effective = { ...current };
            for (const q of queue) {
                if (!effective[q.building] || effective[q.building] < q.targetLevel) {
                    effective[q.building] = q.targetLevel;
                }
            }
            for (const [building, target] of template) {
                const cur = effective[building] || 0;
                if (cur < target) {
                    return { building, fromLevel: cur, toLevel: cur + 1 };
                }
            }
            return null;
        }

        async function enqueueBuildB(villageId, building, csrf) {
            const url = `/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=main&h=${csrf}`;
            const fd = new FormData();
            fd.append('id', building);
            fd.append('force', '1');
            fd.append('destroy', '0');
            fd.append('source', String(villageId));
            try {
                const resp = await fetch(url, {
                    method: 'POST', body: fd, credentials: 'same-origin',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'TribalWars-Ajax': '1',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                    },
                });
                const text = await resp.text();
                let body;
                try { body = JSON.parse(text); } catch (e) { body = null; }
                if (body && body.error && body.error.length) {
                    return { ok: false, error: String(body.error[0]).slice(0, 150) };
                }
                if (body && body.response) return { ok: true };
                if (/error_box|insufficient|recursos|n[ãa]o.+suficiente|premium/i.test(text)) {
                    const m = text.match(/<div[^>]*error[^>]*>([\s\S]{0,200})<\/div>/i);
                    return { ok: false, error: (m ? m[1] : 'erro desconhecido').replace(/<[^>]+>/g, '').trim().slice(0, 150) };
                }
                if (resp.ok) return { ok: true, ambig: true };
                return { ok: false, error: `HTTP ${resp.status}` };
            } catch (e) {
                return { ok: false, error: e.message || String(e) };
            }
        }

        function ensureStatusB(village) {
            if (!BSTATE.villageStatuses[village.id]) {
                BSTATE.villageStatuses[village.id] = {
                    name: village.name, coord: `(${village.x}|${village.y})`,
                    lastBuild: '-', lastRecruit: '-', lastResearch: '-',
                    lastCoin: '-', lastSnob: '-',
                    buildings: null,   // {main:5, wood:8, ...}
                    status: 'pendente',
                };
            }
            return BSTATE.villageStatuses[village.id];
        }

        async function processVillageBuildB(village) {
            const status = ensureStatusB(village);
            status.status = 'lendo sede';
            updateVillagesPanelB();
            let main;
            try { main = await fetchMainScreenB(village.id); }
            catch (e) {
                status.status = `erro fetch: ${e.message}`;
                logB(`Vila ${village.name}: falha ao ler sede:`, e.message);
                return;
            }
            const csrf = parseCsrfB(main.doc);
            if (!csrf) {
                status.status = 'sem CSRF';
                logB(`Vila ${village.name}: CSRF não encontrado`);
                return;
            }
            const current = parseCurrentLevelsB(main.doc);
            status.buildings = current;  // salva pra exibir
            const queue = parseBuildQueueB(main.doc);
            const slotsAvailable = BCFG.queueSlots - queue.length;
            if (slotsAvailable <= 0) {
                status.status = `fila cheia (${queue.length}/${BCFG.queueSlots})`;
                updateVillagesPanelB();
                return;
            }

            // Enche TODOS os slots livres de uma vez (mundo speed = não desperdiça passada).
            // Simulação local: a cada enqueue, atualiza simulatedQueue pra pickNextBuild
            // pegar o PRÓXIMO do template, não repetir o mesmo.
            const simulatedQueue = [...queue];
            const enqueuedThisPass = [];
            const errorsThisPass = [];

            const role = getVillageRoleB(village.id);
            const template = getTemplateForRoleB(role);
            for (let slot = 0; slot < slotsAvailable; slot++) {
                const next = pickNextBuildB(template, current, simulatedQueue);
                if (!next) {
                    if (enqueuedThisPass.length === 0) {
                        status.status = 'template concluído ✓';
                        logB(`Vila ${village.name}: template concluído`);
                    }
                    break;
                }
                status.status = `enfileirando ${next.building}→${next.toLevel} [slot ${slot+1}/${slotsAvailable}]`;
                updateVillagesPanelB();
                const res = await enqueueBuildB(village.id, next.building, csrf);
                if (res.ok) {
                    enqueuedThisPass.push(`${next.building}→${next.toLevel}`);
                    // Simula que o prédio foi adicionado na fila pra o próximo pickNext
                    // escolher o seguinte (não repete o mesmo).
                    simulatedQueue.push({ building: next.building, targetLevel: next.toLevel });
                    // Pausa curta entre múltiplos enqueues na MESMA vila (já autenticado)
                    if (slot < slotsAvailable - 1) {
                        await sleepB(jitterB([500, 1500]));
                    }
                } else {
                    errorsThisPass.push(`${next.building}:${res.error}`);
                    // Tipicamente "recursos insuficientes" — para de tentar nessa vila,
                    // mas mantém o que já enfileirou. Próximo ciclo tenta de novo.
                    break;
                }
            }

            if (enqueuedThisPass.length > 0) {
                status.lastBuild = `${enqueuedThisPass.join(', ')} (${nowStrB()})`;
                status.status = `✓ ${enqueuedThisPass.length}/${slotsAvailable} enfileirados`;
                logB(`Vila ${village.name}: ${enqueuedThisPass.length} prédio(s) enfileirado(s) [${enqueuedThisPass.join(', ')}]`);
            } else if (errorsThisPass.length > 0) {
                status.status = `falhou: ${errorsThisPass[0]}`;
                logB(`Vila ${village.name}: erro - ${errorsThisPass[0]}`);
            }
            updateVillagesPanelB();
        }

        async function buildLoopB() {
            logB(`Build loop iniciado. Ciclo=${BCFG.cycleMs/1000}s, slots/vila=${BCFG.queueSlots}`);
            while (BSTATE.buildRunning) {
                const villages = await getAllVillagesB();
                if (villages.length === 0) {
                    logB('Sem vilas detectadas — aguardando 60s');
                    await sleepB(60000);
                    continue;
                }
                logB(`Ciclo ${++BSTATE.cycleCount} (Build): ${villages.length} vilas`);
                BSTATE.lastCycleAt = Date.now();
                let done = 0;
                for (const v of villages) {
                    if (!BSTATE.buildRunning) break;
                    try { await processVillageBuildB(v); }
                    catch (e) { logB(`Build vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Build progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                if (!BSTATE.buildRunning) break;
                updateMainPanelB();
                logB(`Build passada done. Aguardando ${BCFG.cycleMs/1000}s pro próximo ciclo`);
                const waitUntil = Date.now() + BCFG.cycleMs;
                while (Date.now() < waitUntil && BSTATE.buildRunning) {
                    await sleepB(1000);
                }
            }
            logB('Build loop parado');
        }

        // ============ RECRUIT ============

        const RECRUIT_SCREENS = {
            barracks: ['spear', 'sword', 'axe', 'archer'],
            stable:   ['spy', 'light', 'marcher', 'heavy'],
            garage:   ['ram', 'catapult'],
        };

        async function fetchRecruitScreenB(villageId, screen) {
            const url = `/game.php?village=${villageId}&screen=${screen}`;
            const resp = await fetch(url, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} ${screen}`);
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return { html, doc };
        }

        function parseUnitCostsB(doc) {
            const out = {};
            doc.querySelectorAll('[data-unit]').forEach(el => {
                const u = el.getAttribute('data-unit');
                const c = el.getAttribute('data-costs');
                if (c) {
                    try {
                        const parsed = JSON.parse(c);
                        out[u] = { wood: parsed.wood || 0, stone: parsed.stone || 0, iron: parsed.iron || 0, pop: parsed.pop || 1 };
                    } catch (e) {}
                }
            });
            if (Object.keys(out).length === 0) {
                doc.querySelectorAll('input[name][type="number"], input[name][type="text"]').forEach(inp => {
                    const name = inp.getAttribute('name');
                    if (!name || !/^[a-z]+$/.test(name)) return;
                    const tr = inp.closest('tr');
                    if (!tr) return;
                    const woodEl = tr.querySelector('.cost_wood, [class*="wood"]');
                    const stoneEl = tr.querySelector('.cost_stone, [class*="stone"]');
                    const ironEl = tr.querySelector('.cost_iron, [class*="iron"]');
                    const popEl = tr.querySelector('.cost_pop, [class*="pop"]');
                    const num = el => el ? parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10) || 0 : 0;
                    if (woodEl || stoneEl || ironEl) {
                        out[name] = { wood: num(woodEl), stone: num(stoneEl), iron: num(ironEl), pop: num(popEl) || 1 };
                    }
                });
            }
            return out;
        }

        function parseRecruitFormB(doc) {
            const form = doc.querySelector('form#train_form, form[action*="mode=train"], form[name="train_form"]');
            if (!form) return null;
            const action = form.getAttribute('action') || '';
            const csrf = parseCsrfB(doc);
            const hidden = {};
            form.querySelectorAll('input[type=hidden]').forEach(inp => {
                if (inp.name) hidden[inp.name] = inp.value || '';
            });
            return { form, action, csrf, hidden };
        }

        function computeRecruitAmountsB(resources, mix, costs, maxPerUnit, popFree) {
            const result = {};
            const validUnits = Object.entries(mix).filter(([u, w]) => w > 0 && costs[u]);
            if (validUnits.length === 0) return result;
            const totalWeight = validUnits.reduce((s, [, w]) => s + w, 0);
            const budget = {
                wood: Math.floor(resources.wood * BCFG.recruitResourcePct),
                stone: Math.floor(resources.stone * BCFG.recruitResourcePct),
                iron: Math.floor(resources.iron * BCFG.recruitResourcePct),
                pop: popFree,
            };
            for (const [unit, weight] of validUnits) {
                const c = costs[unit];
                const share = weight / totalWeight;
                const maxByWood  = c.wood  > 0 ? Math.floor(budget.wood  * share / c.wood)  : Infinity;
                const maxByStone = c.stone > 0 ? Math.floor(budget.stone * share / c.stone) : Infinity;
                const maxByIron  = c.iron  > 0 ? Math.floor(budget.iron  * share / c.iron)  : Infinity;
                const maxByPop   = c.pop   > 0 ? Math.floor(budget.pop   * share / c.pop)   : Infinity;
                const qty = Math.max(0, Math.min(maxByWood, maxByStone, maxByIron, maxByPop, maxPerUnit));
                if (qty > 0) result[unit] = qty;
            }
            return result;
        }

        async function recruitInVillageB(villageId, screen) {
            let page;
            try { page = await fetchRecruitScreenB(villageId, screen); }
            catch (e) { return { ok: false, error: `fetch ${screen}: ${e.message}` }; }
            const formInfo = parseRecruitFormB(page.doc);
            if (!formInfo) return { ok: false, error: `${screen} sem form (prédio não construído?)` };
            const costs = parseUnitCostsB(page.doc);
            if (Object.keys(costs).length === 0) return { ok: false, error: `${screen} sem custos parseáveis` };

            const resources = parseResourcesB(page.doc);
            const popFree = Math.max(0, resources.popMax - resources.popUsed);
            // Mix vem do role da vila (OFF / NOBLE), não mais global
            const role = getVillageRoleB(villageId);
            const roleMix = getMixForRoleB(role);
            const mix = {};
            for (const u of RECRUIT_SCREENS[screen]) {
                if (roleMix[u] !== undefined && roleMix[u] > 0) mix[u] = roleMix[u];
            }
            const amounts = computeRecruitAmountsB(resources, mix, costs, BCFG.recruitMaxPerUnit, popFree);
            const totalUnits = Object.values(amounts).reduce((s, n) => s + n, 0);
            if (totalUnits === 0) {
                return { ok: true, sent: {}, note: 'nada a recrutar (recursos/pop insuficientes ou mix zero)' };
            }
            const fd = new FormData();
            for (const [k, v] of Object.entries(formInfo.hidden)) fd.append(k, v);
            for (const u of RECRUIT_SCREENS[screen]) {
                fd.set(`units[${u}]`, String(amounts[u] || 0));
            }
            if (formInfo.csrf) fd.set('h', formInfo.csrf);

            let action = formInfo.action;
            if (!action) action = `/game.php?village=${villageId}&screen=${screen}&mode=train&action=train`;
            if (!/action=train/.test(action) && !/mode=train/.test(action)) {
                action += (action.includes('?') ? '&' : '?') + 'mode=train&action=train';
            }
            if (!action.includes(`village=${villageId}`)) {
                action += (action.includes('?') ? '&' : '?') + `village=${villageId}`;
            }
            try {
                const resp = await fetch(action, { method: 'POST', body: fd, credentials: 'same-origin' });
                const text = await resp.text();
                if (/error_box|insufficient|n[ãa]o.+suficiente/i.test(text)) {
                    const m = text.match(/<div[^>]*error[^>]*>([\s\S]{0,200})<\/div>/i);
                    return { ok: false, error: (m ? m[1] : 'erro').replace(/<[^>]+>/g, '').trim().slice(0, 150), sent: amounts };
                }
                return { ok: true, sent: amounts };
            } catch (e) {
                return { ok: false, error: e.message, sent: amounts };
            }
        }

        async function processVillageRecruitB(village) {
            const status = ensureStatusB(village);
            const summary = [];
            for (const screen of Object.keys(RECRUIT_SCREENS)) {
                if (!BSTATE.recruitRunning && !BSTATE._oneShot) break;
                const res = await recruitInVillageB(village.id, screen);
                if (res.ok && Object.keys(res.sent || {}).length > 0) {
                    const parts = Object.entries(res.sent).map(([u, n]) => `${u}:${n}`).join(' ');
                    summary.push(`${screen}[${parts}]`);
                    logB(`Vila ${village.name} ${screen}: ${parts}`);
                } else if (!res.ok) {
                    logB(`Vila ${village.name} ${screen} falhou: ${res.error}`);
                }
                await sleepB(jitterB());
            }
            if (summary.length > 0) {
                status.lastRecruit = `${summary.join(' ')} (${nowStrB()})`;
            }
            updateVillagesPanelB();
        }

        async function recruitLoopB() {
            logB(`Recruit loop iniciado. Mix=${JSON.stringify(BSTATE.troopMix)}`);
            while (BSTATE.recruitRunning) {
                const villages = await getAllVillagesB();
                if (villages.length === 0) {
                    logB('Recruit: sem vilas, aguardando');
                    await sleepB(60000);
                    continue;
                }
                logB(`Ciclo Recruit: ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    if (!BSTATE.recruitRunning) break;
                    try { await processVillageRecruitB(v); }
                    catch (e) { logB(`Recruit vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Recruit progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                if (!BSTATE.recruitRunning) break;
                logB(`Recruit passada done, aguardando ${BCFG.cycleMs/1000}s`);
                const waitUntil = Date.now() + BCFG.cycleMs;
                while (Date.now() < waitUntil && BSTATE.recruitRunning) {
                    await sleepB(1000);
                }
            }
            logB('Recruit loop parado');
        }

        // ============ RESEARCH (ferreiro) ============
        // Em mundos com sistema de pesquisa, NÃO dá pra recrutar sem pesquisar antes.
        // Tenta pesquisar tudo que estiver liberado (recursos + ferreiro nível ok)
        // pra cada vila. Custo-benefício: 1 GET + N POSTs por vila por passada.

        async function fetchSmithyB(villageId) {
            const url = `/game.php?village=${villageId}&screen=smith`;
            const resp = await fetch(url, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} smith`);
            const html = await resp.text();
            return new DOMParser().parseFromString(html, 'text/html');
        }

        function parseResearchOptionsB(doc) {
            // Várias variantes possíveis. Tentamos múltiplos padrões.
            const out = [];
            const seen = new Set();

            // Padrão 1: form com action contendo action=research, input name=tech
            doc.querySelectorAll('form').forEach(form => {
                const action = form.getAttribute('action') || '';
                if (!/action=research|smith.*research|research.*smith/i.test(action)) return;
                const techInput = form.querySelector('input[name="tech"], input[name="tech_id"], input[name="unit"]');
                if (!techInput || !techInput.value) return;
                const tech = techInput.value;
                if (seen.has(tech)) return;
                // Botão habilitado? (sem disabled, sem display:none no row pai)
                const btn = form.querySelector('input[type=submit], button[type=submit]');
                if (btn && btn.disabled) return;
                const hidden = {};
                form.querySelectorAll('input').forEach(inp => {
                    if (inp.name) hidden[inp.name] = inp.value || '';
                });
                seen.add(tech);
                out.push({ tech, action, hidden });
            });

            // Padrão 2: links/botões com onclick="Research.research('spear')" ou href com tech_id
            doc.querySelectorAll('a[onclick*="esearch"], a[href*="tech_id"], a[href*="action=research"]').forEach(link => {
                const onclick = link.getAttribute('onclick') || '';
                const href = link.getAttribute('href') || '';
                let tech = null;
                const m1 = onclick.match(/['"]([\w]+)['"]/);
                if (m1) tech = m1[1];
                if (!tech) {
                    const m2 = href.match(/[?&]tech(?:_id)?=([\w]+)/);
                    if (m2) tech = m2[1];
                }
                if (!tech) return;
                if (seen.has(tech)) return;
                // Pula se link está desabilitado (classe com "disabled" ou "not-researchable")
                if (/disabled|inactive|not.?research/i.test(link.className)) return;
                seen.add(tech);
                out.push({ tech, action: href.startsWith('/') ? href : null, hidden: {} });
            });

            return out;
        }

        async function researchInVillageB(villageId) {
            let doc;
            try { doc = await fetchSmithyB(villageId); }
            catch (e) { return { ok: false, error: 'smith não acessível: ' + e.message }; }
            const csrf = parseCsrfB(doc);
            let options = parseResearchOptionsB(doc);
            if (options.length === 0) return { ok: true, researched: [], note: 'sem pesquisas disponíveis' };

            // Filtrar pelo whitelist do role (não desperdiça smith pesquisando o que não vai recrutar)
            const role = getVillageRoleB(villageId);
            const whitelist = getResearchWhitelistForRoleB(role);
            const filtered = options.filter(opt => whitelist.includes(opt.tech));
            if (filtered.length === 0) {
                return { ok: true, researched: [], note: `nada no whitelist do role ${role}` };
            }
            options = filtered;

            const researched = [];
            const failed = [];
            for (let i = 0; i < Math.min(options.length, BCFG.researchAttempts); i++) {
                const opt = options[i];
                const fd = new FormData();
                for (const [k, v] of Object.entries(opt.hidden)) fd.append(k, v);
                if (csrf) fd.set('h', csrf);
                if (!fd.has('tech')) fd.set('tech', opt.tech);
                let actionUrl = opt.action;
                if (!actionUrl || !/screen=smith/.test(actionUrl)) {
                    actionUrl = `/game.php?village=${villageId}&screen=smith&action=research&h=${csrf || ''}`;
                }
                if (actionUrl.startsWith('/') && !actionUrl.includes(`village=${villageId}`)) {
                    actionUrl += (actionUrl.includes('?') ? '&' : '?') + `village=${villageId}`;
                }
                try {
                    const r = await fetch(actionUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
                    const text = await r.text();
                    if (r.ok && !/error_box|recursos|insufficient/i.test(text)) {
                        researched.push(opt.tech);
                    } else {
                        failed.push(opt.tech);
                    }
                } catch (e) {
                    failed.push(opt.tech);
                }
                await sleepB(jitterB());
            }
            return { ok: true, researched, failed };
        }

        async function processVillageResearchB(village) {
            const status = ensureStatusB(village);
            const res = await researchInVillageB(village.id);
            if (res.ok) {
                if (res.researched && res.researched.length > 0) {
                    status.lastResearch = `${res.researched.join(',')} (${nowStrB()})`;
                    logB(`Vila ${village.name} smith: pesquisou ${res.researched.join(', ')}`);
                } else if (res.note) {
                    // sem pesquisas disponíveis — silencioso
                }
            } else {
                logB(`Vila ${village.name} smith falhou: ${res.error}`);
            }
            updateVillagesPanelB();
        }

        async function researchLoopB() {
            logB('Research loop iniciado');
            while (BSTATE.researchRunning) {
                const villages = await getAllVillagesB();
                if (villages.length === 0) {
                    await sleepB(60000);
                    continue;
                }
                logB(`Ciclo Research: ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    if (!BSTATE.researchRunning) break;
                    try { await processVillageResearchB(v); }
                    catch (e) { logB(`Research vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Research progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                if (!BSTATE.researchRunning) break;
                logB(`Research passada done, aguardando ${BCFG.cycleMs/1000}s`);
                const waitUntil = Date.now() + BCFG.cycleMs;
                while (Date.now() < waitUntil && BSTATE.researchRunning) {
                    await sleepB(1000);
                }
            }
            logB('Research loop parado');
        }

        // ============ COIN MINTER (academia) ============
        // Em mundos com sistema de moedas: cada nobre custa N moedas (1, 3, 6, 10...)
        // Cunhagem custa madeira/argila/ferro. Faz sentido cunhar continuamente em
        // todas as vilas que tem academia, acumulando moedas pra próximos nobres.

        async function fetchSnobScreenB(villageId) {
            const url = `/game.php?village=${villageId}&screen=snob`;
            const resp = await fetch(url, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} snob`);
            const html = await resp.text();
            return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
        }

        function parseCoinFormB(doc) {
            // Form típico: <form action="...&action=coin&h=..." method=POST> + input name=coin (qty)
            // Variantes: action=coin / action=mint / action=mint_coin
            const forms = doc.querySelectorAll('form');
            for (const form of forms) {
                const action = form.getAttribute('action') || '';
                if (!/(action=coin|action=mint)/i.test(action)) continue;
                const hidden = {};
                form.querySelectorAll('input').forEach(inp => {
                    if (inp.name && inp.type !== 'submit') hidden[inp.name] = inp.value || '';
                });
                return { action, hidden };
            }
            return null;
        }

        function parseCoinCountB(doc) {
            // Texto tipo "Moedas: 12" ou "Moedas armazenadas: 12"
            const text = doc.body ? (doc.body.textContent || '') : '';
            const m = text.match(/[Mm]oedas\D{1,15}(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        }

        async function mintCoinsInVillageB(villageId, amount) {
            let page;
            try { page = await fetchSnobScreenB(villageId); }
            catch (e) { return { ok: false, error: 'snob não acessível: ' + e.message }; }
            const formInfo = parseCoinFormB(page.doc);
            if (!formInfo) return { ok: false, error: 'sem form de cunhagem (academia não construída?)' };
            const coinsBefore = parseCoinCountB(page.doc);
            const csrf = parseCsrfB(page.doc);

            const fd = new FormData();
            for (const [k, v] of Object.entries(formInfo.hidden)) fd.append(k, v);
            // Variantes de nome do input: coin, coins, amount, qty
            fd.set('coin', String(amount));
            fd.set('coins', String(amount));
            fd.set('amount', String(amount));
            if (csrf) fd.set('h', csrf);

            let actionUrl = formInfo.action;
            if (actionUrl.startsWith('/') && !actionUrl.includes(`village=${villageId}`)) {
                actionUrl += (actionUrl.includes('?') ? '&' : '?') + `village=${villageId}`;
            }
            try {
                const r = await fetch(actionUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
                const text = await r.text();
                if (/error_box|insufficient|n[ãa]o.+suficiente|recursos/i.test(text)) {
                    const m = text.match(/<div[^>]*error[^>]*>([\s\S]{0,200})<\/div>/i);
                    return { ok: false, error: (m ? m[1] : 'erro').replace(/<[^>]+>/g, '').trim().slice(0, 150), coinsBefore };
                }
                return { ok: true, coinsBefore, mintedRequested: amount };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        async function processVillageCoinB(village) {
            const status = ensureStatusB(village);
            // Cunhagem só em vilas NOBLE (desperdício em OFF que nem tem academia)
            if (getVillageRoleB(village.id) !== 'NOBLE') {
                status.lastCoin = 'skip (não-NOBLE)';
                return;
            }
            const res = await mintCoinsInVillageB(village.id, BCFG.coinsPerCycle || 1);
            if (res.ok) {
                status.lastCoin = `+${res.mintedRequested} (${nowStrB()})`;
                logB(`Vila ${village.name}: cunhou ${res.mintedRequested} moeda(s) (tinha ${res.coinsBefore ?? '?'})`);
            } else if (!/academia n[ãa]o constru/i.test(res.error || '')) {
                logB(`Vila ${village.name} coin: ${res.error}`);
            }
            updateVillagesPanelB();
        }

        async function coinLoopB() {
            logB('Coin loop iniciado');
            while (BSTATE.coinRunning) {
                const villages = await getAllVillagesB();
                if (villages.length === 0) { await sleepB(60000); continue; }
                logB(`Ciclo Coin: ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    if (!BSTATE.coinRunning) break;
                    try { await processVillageCoinB(v); }
                    catch (e) { logB(`Coin vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Coin progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                if (!BSTATE.coinRunning) break;
                logB(`Coin passada done, aguardando ${BCFG.cycleMs/1000}s`);
                const waitUntil = Date.now() + BCFG.cycleMs;
                while (Date.now() < waitUntil && BSTATE.coinRunning) await sleepB(1000);
            }
            logB('Coin loop parado');
        }

        // ============ SNOB TRAINER (treinar nobres) ============
        // Mundos COM moedas: precisa N moedas (1, 3, 6, 10, 15...) pra treinar próximo.
        // Mundos SEM moedas: pop + recursos diretos.
        // Cap em BCFG.maxNobles pra não recrutar 1000 sem querer.

        function parseSnobTrainFormB(doc) {
            // Variantes: form com action contendo action=train ou submit="Treinar"
            const forms = doc.querySelectorAll('form');
            for (const form of forms) {
                const action = form.getAttribute('action') || '';
                const html = form.innerHTML;
                if (!/(action=train|train.*nobre|noble|recruit_snob)/i.test(action + ' ' + html)) continue;
                // Botão de submit precisa estar habilitado
                const submit = form.querySelector('input[type=submit], button[type=submit]');
                if (submit && (submit.disabled || /disabled/i.test(submit.outerHTML))) continue;
                const hidden = {};
                form.querySelectorAll('input').forEach(inp => {
                    if (inp.name && inp.type !== 'submit') hidden[inp.name] = inp.value || '';
                });
                return { action, hidden };
            }
            return null;
        }

        async function trainSnobInVillageB(villageId) {
            let page;
            try { page = await fetchSnobScreenB(villageId); }
            catch (e) { return { ok: false, error: 'snob não acessível: ' + e.message }; }
            const formInfo = parseSnobTrainFormB(page.doc);
            if (!formInfo) return { ok: true, note: 'sem form de treinar (sem moedas ou pop?)' };
            const csrf = parseCsrfB(page.doc);

            const fd = new FormData();
            for (const [k, v] of Object.entries(formInfo.hidden)) fd.append(k, v);
            if (csrf) fd.set('h', csrf);

            let actionUrl = formInfo.action;
            if (actionUrl.startsWith('/') && !actionUrl.includes(`village=${villageId}`)) {
                actionUrl += (actionUrl.includes('?') ? '&' : '?') + `village=${villageId}`;
            }
            try {
                const r = await fetch(actionUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
                const text = await r.text();
                if (/error_box|insufficient|n[ãa]o.+suficiente/i.test(text)) {
                    const m = text.match(/<div[^>]*error[^>]*>([\s\S]{0,200})<\/div>/i);
                    return { ok: false, error: (m ? m[1] : 'erro').replace(/<[^>]+>/g, '').trim().slice(0, 150) };
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        async function processVillageSnobB(village) {
            const status = ensureStatusB(village);
            // Treinar nobre só em vilas NOBLE
            if (getVillageRoleB(village.id) !== 'NOBLE') {
                status.lastSnob = 'skip (não-NOBLE)';
                return;
            }
            const res = await trainSnobInVillageB(village.id);
            if (res.ok && !res.note) {
                status.lastSnob = `treinou nobre (${nowStrB()})`;
                logB(`Vila ${village.name}: NOBRE treinado ⚜`);
            } else if (!res.ok) {
                logB(`Vila ${village.name} snob: ${res.error}`);
            }
            updateVillagesPanelB();
        }

        async function snobLoopB() {
            logB('Snob loop iniciado');
            while (BSTATE.snobRunning) {
                const villages = await getAllVillagesB();
                if (villages.length === 0) { await sleepB(60000); continue; }
                logB(`Ciclo Snob: ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    if (!BSTATE.snobRunning) break;
                    try { await processVillageSnobB(v); }
                    catch (e) { logB(`Snob vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Snob progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                if (!BSTATE.snobRunning) break;
                logB(`Snob passada done, aguardando ${BCFG.cycleMs/1000}s`);
                const waitUntil = Date.now() + BCFG.cycleMs;
                while (Date.now() < waitUntil && BSTATE.snobRunning) await sleepB(1000);
            }
            logB('Snob loop parado');
        }

        // ============ PAINEL ============

        function injectPanelB() {
            if (document.getElementById('tw-build-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'tw-build-panel';
            panel.innerHTML = `
<div style="position:fixed;top:120px;left:10px;z-index:99998;background:#e9f0e0;border:2px solid #1f5d1f;padding:8px;font-family:Verdana,Arial;font-size:11px;width:320px;box-shadow:2px 2px 8px rgba(0,0,0,0.4);border-radius:3px;max-height:85vh;overflow-y:auto;">
  <div style="font-weight:bold;border-bottom:1px solid #1f5d1f;margin-bottom:6px;color:#1f5d1f;">🏗 TW Build + Research + Recruit (v0.5.0)</div>

  <div style="display:flex;gap:4px;margin-bottom:6px;">
    <button id="tw-bld-startall" style="flex:2;background:#0f5f0f;color:white;border:none;padding:8px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:12px;">▶▶▶ START TUDO</button>
    <button id="tw-bld-stopall" style="flex:1;background:#7a1f1f;color:white;border:none;padding:8px;cursor:pointer;font-weight:bold;border-radius:2px;">■ STOP TUDO</button>
  </div>

  <div style="background:#f0e0d0;border:1px solid #a07000;padding:5px;margin-bottom:6px;font-size:10px;border-radius:2px;">
    <b>🎭 Roles:</b>
    <span style="background:#5d1f7a;color:#fff;padding:1px 4px;border-radius:2px;">👑 NOBLE</span> = <input id="tw-roles-noble-count" type="number" value="${BSTATE.nobleCount}" min="0" max="50" style="width:40px;font-size:10px;"/> primeiras vilas
    (cunha+treina nobre, mix com escolta)<br>
    <span style="background:#7a1f1f;color:#fff;padding:1px 4px;border-radius:2px;">⚔ OFF</span> = resto (full heavy, sem academia)
    <button id="tw-roles-edit" style="background:#a07000;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;margin-left:4px;">✎ Override</button>
    <button id="tw-roles-templates" style="background:#1f4d7a;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;">✎ Templates</button>
  </div>

  <div style="font-weight:bold;color:#1f5d1f;margin:6px 0 3px;">⚙ Config global</div>
  <div style="display:flex;gap:4px;align-items:center;margin-bottom:3px;flex-wrap:wrap;">
    <span>Ciclo (s):</span>
    <input id="tw-bld-cycle" type="number" value="${BCFG.cycleMs/1000}" min="30" max="3600" style="width:60px;font-size:10px;"/>
    <span>Slots fila:</span>
    <input id="tw-bld-slots" type="number" value="${BCFG.queueSlots}" min="1" max="5" style="width:40px;font-size:10px;"/>
    <span title="% dos recursos disponíveis pra recrutar">Recrut %:</span>
    <input id="tw-bld-recpct" type="number" value="${Math.round(BCFG.recruitResourcePct*100)}" min="10" max="100" style="width:50px;font-size:10px;"/>
    <button id="tw-bld-refresh-villages" style="background:#1f4d7a;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;">⟳ Vilas</button>
    <button id="tw-bld-diag" style="background:#a04000;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;" title="Diagnostico verbose no console F12">🔎 Diag</button>
  </div>

  <div style="font-weight:bold;color:#1f5d1f;margin:8px 0 3px;">🏗 Build Queue</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-bld-start" style="flex:1;background:#1f7a1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">▶ Build</button>
    <button id="tw-bld-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">■ Stop</button>
    <button id="tw-bld-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
    <button id="tw-bld-edit-template" style="flex:1;background:#1f4d7a;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">✎ Tpl</button>
  </div>
  <div style="font-size:10px;">Build: <span id="tw-bld-status">parado</span> · Ciclos: <span id="tw-bld-cycles">0</span></div>

  <div style="font-weight:bold;color:#1f5d1f;margin:8px 0 3px;">🔬 Research (ferreiro)</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-res-start" style="flex:1;background:#5d1f7a;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">▶ Research</button>
    <button id="tw-res-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">■ Stop</button>
    <button id="tw-res-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
  </div>
  <div style="font-size:10px;">Research: <span id="tw-res-status">parado</span></div>

  <div style="font-weight:bold;color:#1f5d1f;margin:8px 0 3px;">⚜ Academia (cunhar + treinar nobre)</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-coin-start" style="flex:1;background:#a07000;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">▶ Coin</button>
    <button id="tw-coin-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">■ Stop</button>
    <button id="tw-coin-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
  </div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-snob-start" style="flex:1;background:#5d1f7a;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">▶ Nobre</button>
    <button id="tw-snob-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">■ Stop</button>
    <button id="tw-snob-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
  </div>
  <div style="font-size:10px;">Coin: <span id="tw-coin-status">parado</span> · Nobre: <span id="tw-snob-status">parado</span></div>

  <div style="font-weight:bold;color:#1f5d1f;margin:8px 0 3px;">⚔ Recruit</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-rec-start" style="flex:1;background:#7a4d1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">▶ Recruit</button>
    <button id="tw-rec-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">■ Stop</button>
    <button id="tw-rec-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
    <button id="tw-rec-edit-mix" style="flex:1;background:#1f4d7a;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">✎ Mix</button>
  </div>
  <div style="font-size:10px;">Recruit: <span id="tw-rec-status">parado</span></div>
  <div style="font-size:9px;color:#666;margin-top:2px;">Mix: <span id="tw-rec-mix-display">OFF:${formatMixB(BSTATE.mixes.OFF)} | NOBLE:${formatMixB(BSTATE.mixes.NOBLE)}</span></div>

  <hr style="border:none;border-top:1px solid #1f5d1f;margin:8px 0 6px;">

  <div style="font-weight:bold;color:#1f5d1f;margin-bottom:3px;">📊 Vilas (<span id="tw-bld-vcount">?</span>)</div>
  <div id="tw-bld-villages" style="font-size:10px;max-height:200px;overflow-y:auto;border:1px solid #ccc;padding:4px;background:#fff;">aguardando...</div>

  <hr style="border:none;border-top:1px solid #1f5d1f;margin:8px 0 6px;">

  <div style="font-weight:bold;color:#1f5d1f;margin-bottom:3px;">📜 Log (últimas 30)</div>
  <div id="tw-bld-log" style="font-size:9px;max-height:140px;overflow-y:auto;border:1px solid #ccc;padding:4px;background:#fff;font-family:monospace;white-space:pre-wrap;"></div>
</div>`;
            document.body.appendChild(panel);

            document.getElementById('tw-bld-startall').onclick = async () => {
                applyCfgFromPanelB();
                if (!BSTATE.buildRunning) { BSTATE.buildRunning = true; buildLoopB(); }
                if (BCFG.researchEnabled && !BSTATE.researchRunning) { BSTATE.researchRunning = true; researchLoopB(); }
                if (!BSTATE.coinRunning) { BSTATE.coinRunning = true; coinLoopB(); }
                if (!BSTATE.snobRunning) { BSTATE.snobRunning = true; snobLoopB(); }
                if (!BSTATE.recruitRunning) { BSTATE.recruitRunning = true; recruitLoopB(); }
                updateMainPanelB();
                logB('▶▶▶ START TUDO: Build + Research + Coin + Snob + Recruit rodando');
            };
            document.getElementById('tw-bld-stopall').onclick = () => {
                BSTATE.buildRunning = false;
                BSTATE.researchRunning = false;
                BSTATE.coinRunning = false;
                BSTATE.snobRunning = false;
                BSTATE.recruitRunning = false;
                updateMainPanelB();
                logB('■ STOP TUDO');
            };
            document.getElementById('tw-bld-refresh-villages').onclick = async () => {
                logB('Re-descobrindo vilas...');
                const v = await getAllVillagesB(true);
                logB(`Encontradas ${v.length} vilas`);
                updateVillagesPanelB();
            };
            document.getElementById('tw-bld-diag').onclick = async () => {
                console.log('%c═══ TW-BUILD DIAGNÓSTICO ═══', 'color:#a04000;font-size:14px;font-weight:bold');
                const gd = getGameDataB();
                console.log('1) game_data existe?', !!gd);
                if (gd) {
                    console.log('   game_data.world:', gd.world);
                    console.log('   game_data.player.name:', gd.player?.name);
                    console.log('   game_data.player.id:', gd.player?.id);
                    console.log('   game_data.villages (array)?', Array.isArray(gd.villages), 'len:', gd.villages?.length);
                    console.log('   game_data.player.villages?', typeof gd.player?.villages, 'len:',
                        Array.isArray(gd.player?.villages) ? gd.player.villages.length :
                        (gd.player?.villages ? Object.keys(gd.player.villages).length : 0));
                    console.log('   game_data.village (ativa):', gd.village);
                }
                const fromGd = villagesFromGameDataB();
                console.log('2) Extraídas de game_data:', fromGd.length, 'vilas');
                console.table(fromGd.slice(0, 5));
                console.log('3) Buscando overview_villages...');
                const fromOverview = await fetchVillagesFromOverviewB();
                console.log('   Overview retornou:', fromOverview.length, 'vilas');
                console.table(fromOverview.slice(0, 5));
                console.log('4) Cache atual (getAllVillagesSyncB):', getAllVillagesSyncB().length, 'vilas');
                const final = await getAllVillagesB(true);
                console.log('5) Final (force refresh):', final.length, 'vilas');
                console.log('%c═══ FIM DIAGNÓSTICO — escolhida: ' + final.length + ' vilas ═══', 'color:#a04000;font-size:14px;font-weight:bold');
                logB(`Diagnóstico: gd=${fromGd.length}, overview=${fromOverview.length}, final=${final.length}. Detalhes no console F12.`);
                updateVillagesPanelB();
                wB.TW_BUILD_LAST_DIAG = { gd: fromGd, overview: fromOverview, final };
                alert(`Diagnóstico:\n\n- game_data: ${fromGd.length} vilas\n- overview_villages: ${fromOverview.length} vilas\n- usado: ${final.length} vilas\n\nDetalhes completos no console (F12).\nObjeto salvo em window.TW_BUILD_LAST_DIAG`);
            };

            document.getElementById('tw-bld-start').onclick = () => {
                applyCfgFromPanelB();
                if (BSTATE.buildRunning) { logB('Build já está rodando'); return; }
                BSTATE.buildRunning = true;
                updateMainPanelB();
                buildLoopB();
            };
            document.getElementById('tw-bld-stop').onclick = () => {
                BSTATE.buildRunning = false;
                updateMainPanelB();
            };
            document.getElementById('tw-bld-once').onclick = async () => {
                applyCfgFromPanelB();
                logB('Build: rodando 1 ciclo de debug');
                const villages = await getAllVillagesB();
                logB(`Build debug: processando ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    try { await processVillageBuildB(v); }
                    catch (e) { logB(`Build vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Build debug progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                logB(`Build: ciclo debug terminado (${done} vilas)`);
            };

            document.getElementById('tw-res-start').onclick = () => {
                applyCfgFromPanelB();
                if (BSTATE.researchRunning) { logB('Research já está rodando'); return; }
                BSTATE.researchRunning = true;
                updateMainPanelB();
                researchLoopB();
            };
            document.getElementById('tw-res-stop').onclick = () => {
                BSTATE.researchRunning = false;
                updateMainPanelB();
            };
            document.getElementById('tw-res-once').onclick = async () => {
                applyCfgFromPanelB();
                logB('Research: rodando 1 ciclo de debug');
                const villages = await getAllVillagesB();
                logB(`Research debug: processando ${villages.length} vilas`);
                let done = 0;
                for (const v of villages) {
                    try { await processVillageResearchB(v); }
                    catch (e) { logB(`Research vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Research debug progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                logB(`Research: ciclo debug terminado (${done} vilas)`);
            };

            // ===== COIN handlers =====
            document.getElementById('tw-coin-start').onclick = () => {
                applyCfgFromPanelB();
                if (BSTATE.coinRunning) { logB('Coin já está rodando'); return; }
                BSTATE.coinRunning = true;
                updateMainPanelB();
                coinLoopB();
            };
            document.getElementById('tw-coin-stop').onclick = () => {
                BSTATE.coinRunning = false;
                updateMainPanelB();
            };
            document.getElementById('tw-coin-once').onclick = async () => {
                applyCfgFromPanelB();
                logB('Coin: rodando 1 ciclo de debug');
                const villages = await getAllVillagesB();
                let done = 0;
                for (const v of villages) {
                    try { await processVillageCoinB(v); }
                    catch (e) { logB(`Coin vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Coin debug progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                logB(`Coin: ciclo debug terminado (${done} vilas)`);
            };

            // ===== SNOB handlers =====
            document.getElementById('tw-snob-start').onclick = () => {
                applyCfgFromPanelB();
                if (BSTATE.snobRunning) { logB('Snob já está rodando'); return; }
                BSTATE.snobRunning = true;
                updateMainPanelB();
                snobLoopB();
            };
            document.getElementById('tw-snob-stop').onclick = () => {
                BSTATE.snobRunning = false;
                updateMainPanelB();
            };
            document.getElementById('tw-snob-once').onclick = async () => {
                applyCfgFromPanelB();
                logB('Snob: rodando 1 ciclo de debug');
                const villages = await getAllVillagesB();
                let done = 0;
                for (const v of villages) {
                    try { await processVillageSnobB(v); }
                    catch (e) { logB(`Snob vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Snob debug progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                logB(`Snob: ciclo debug terminado (${done} vilas)`);
            };
            document.getElementById('tw-bld-edit-template').onclick = () => {
                const role = prompt('Editar template de qual role? Digite OFF ou NOBLE:', 'OFF');
                if (!role || (role !== 'OFF' && role !== 'NOBLE')) return;
                const current = JSON.stringify(BSTATE.templates[role], null, 0).replace(/\],\[/g, '],\n[');
                const next = prompt(
                    `Template ${role} — array JSON [["building", nível], ...]\n` +
                    'Buildings: main, barracks, stable, garage, snob, smith, place, market, wood, stone, iron, farm, storage, hide, wall',
                    current
                );
                if (next === null) return;
                try {
                    const parsed = JSON.parse(next);
                    if (!Array.isArray(parsed)) throw new Error('precisa ser array');
                    BSTATE.templates[role] = parsed;
                    const custom = lsGetB(LS_TEMPLATES_CUSTOM, {});
                    custom[role] = parsed;
                    lsSetB(LS_TEMPLATES_CUSTOM, custom);
                    logB(`Template ${role} atualizado: ${parsed.length} entradas`);
                } catch (e) {
                    alert('Template inválido: ' + e.message);
                }
            };

            // === Roles handlers ===
            document.getElementById('tw-roles-noble-count').onchange = (e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0) {
                    BSTATE.nobleCount = n;
                    lsSetB(LS_NOBLE_COUNT, n);
                    logB(`Vilas NOBLE = primeiras ${n} da lista`);
                    updateVillagesPanelB();
                }
            };
            document.getElementById('tw-roles-edit').onclick = () => {
                const current = JSON.stringify(BSTATE.rolesOverride, null, 2);
                const next = prompt(
                    'Override manual de roles — JSON {"villageId": "OFF" ou "NOBLE"}\n' +
                    'Use o ID da vila (aparece no painel ao lado do nome).\n' +
                    'Vilas sem override usam a regra default (primeiras N = NOBLE).',
                    current
                );
                if (next === null) return;
                try {
                    const parsed = JSON.parse(next);
                    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('precisa ser objeto');
                    BSTATE.rolesOverride = parsed;
                    lsSetB(LS_ROLES_OVERRIDE, parsed);
                    logB(`Override de roles atualizado: ${Object.keys(parsed).length} vilas com override manual`);
                    updateVillagesPanelB();
                } catch (e) {
                    alert('Override inválido: ' + e.message);
                }
            };
            document.getElementById('tw-roles-templates').onclick = () => {
                const role = prompt('Editar template de qual role? Digite OFF ou NOBLE:', 'OFF');
                if (!role || (role !== 'OFF' && role !== 'NOBLE')) return;
                const current = JSON.stringify(BSTATE.templates[role], null, 0).replace(/\],\[/g, '],\n[');
                const next = prompt(
                    `Template ${role} — array JSON [["building", nível], ...]`,
                    current
                );
                if (next === null) return;
                try {
                    const parsed = JSON.parse(next);
                    BSTATE.templates[role] = parsed;
                    const custom = lsGetB(LS_TEMPLATES_CUSTOM, {});
                    custom[role] = parsed;
                    lsSetB(LS_TEMPLATES_CUSTOM, custom);
                    logB(`Template ${role} atualizado: ${parsed.length} entradas`);
                } catch (e) { alert('Template inválido: ' + e.message); }
            };

            document.getElementById('tw-rec-start').onclick = () => {
                applyCfgFromPanelB();
                if (BSTATE.recruitRunning) { logB('Recruit já está rodando'); return; }
                BSTATE.recruitRunning = true;
                updateMainPanelB();
                recruitLoopB();
            };
            document.getElementById('tw-rec-stop').onclick = () => {
                BSTATE.recruitRunning = false;
                updateMainPanelB();
            };
            document.getElementById('tw-rec-once').onclick = async () => {
                applyCfgFromPanelB();
                logB('Recruit: rodando 1 ciclo de debug');
                const villages = await getAllVillagesB();
                logB(`Recruit debug: processando ${villages.length} vilas`);
                let done = 0;
                BSTATE._oneShot = true;
                for (const v of villages) {
                    try { await processVillageRecruitB(v); }
                    catch (e) { logB(`Recruit vila ${v.name} crashou: ${e.message}`); }
                    done++;
                    if (done % 10 === 0) logB(`Recruit debug progresso: ${done}/${villages.length}`);
                    await sleepB(jitterB(BCFG.perVillagePauseMs));
                }
                BSTATE._oneShot = false;
                logB(`Recruit: ciclo debug terminado (${done} vilas)`);
            };
            document.getElementById('tw-rec-edit-mix').onclick = () => {
                const role = prompt('Editar mix de qual role? Digite OFF ou NOBLE:', 'OFF');
                if (!role || (role !== 'OFF' && role !== 'NOBLE')) return;
                const current = JSON.stringify(BSTATE.mixes[role], null, 0);
                const next = prompt(
                    `Mix ${role} — objeto JSON {unit: peso, ...}\n` +
                    'Ex full heavy: {"heavy":1.0}\n' +
                    'Ex escolta: {"heavy":0.3,"spy":0.05}\n' +
                    'Unidades: spear sword axe archer spy light marcher heavy ram catapult',
                    current
                );
                if (next === null) return;
                try {
                    const parsed = JSON.parse(next);
                    BSTATE.mixes[role] = parsed;
                    const custom = lsGetB(LS_MIXES_CUSTOM, {});
                    custom[role] = parsed;
                    lsSetB(LS_MIXES_CUSTOM, custom);
                    document.getElementById('tw-rec-mix-display').textContent = `OFF:${formatMixB(BSTATE.mixes.OFF)} | NOBLE:${formatMixB(BSTATE.mixes.NOBLE)}`;
                    logB(`Mix ${role} atualizado: ${JSON.stringify(parsed)}`);
                } catch (e) {
                    alert('Mix inválido: ' + e.message);
                }
            };

            updateMainPanelB();
            updateVillagesPanelB();
            updateLogPanelB();
        }

        function applyCfgFromPanelB() {
            const cycle = parseInt(document.getElementById('tw-bld-cycle').value, 10);
            if (Number.isFinite(cycle) && cycle >= 30) BCFG.cycleMs = cycle * 1000;
            const slots = parseInt(document.getElementById('tw-bld-slots').value, 10);
            if (Number.isFinite(slots) && slots > 0) BCFG.queueSlots = slots;
            const pct = parseInt(document.getElementById('tw-bld-recpct').value, 10);
            if (Number.isFinite(pct) && pct > 0) BCFG.recruitResourcePct = Math.min(1, pct / 100);
        }

        function formatMixB(mix) {
            return Object.entries(mix)
                .filter(([, w]) => w > 0)
                .map(([u, w]) => `${u}:${Math.round(w*100)}%`)
                .join(' ');
        }

        function updateMainPanelB() {
            const $ = id => document.getElementById(id);
            if ($('tw-bld-status')) $('tw-bld-status').textContent = BSTATE.buildRunning ? 'rodando ▶' : 'parado';
            if ($('tw-res-status')) $('tw-res-status').textContent = BSTATE.researchRunning ? 'rodando ▶' : 'parado';
            if ($('tw-coin-status')) $('tw-coin-status').textContent = BSTATE.coinRunning ? 'rodando ▶' : 'parado';
            if ($('tw-snob-status')) $('tw-snob-status').textContent = BSTATE.snobRunning ? 'rodando ▶' : 'parado';
            if ($('tw-rec-status')) $('tw-rec-status').textContent = BSTATE.recruitRunning ? 'rodando ▶' : 'parado';
            if ($('tw-bld-cycles')) $('tw-bld-cycles').textContent = BSTATE.cycleCount;
        }

        function formatBuildingsB(b) {
            if (!b) return '-';
            // Abreviações curtas pro display
            const order = ['main','barracks','stable','garage','smith','place','market','wood','stone','iron','farm','storage','wall','hide'];
            const labels = {main:'sd', barracks:'qt', stable:'es', garage:'of', smith:'fr', place:'pç', market:'mc',
                wood:'md', stone:'ar', iron:'fe', farm:'fz', storage:'az', wall:'mu', hide:'es'};
            return order.filter(k => b[k]).map(k => `${labels[k] || k}${b[k]}`).join(' ');
        }

        function updateVillagesPanelB() {
            const $list = document.getElementById('tw-bld-villages');
            const $count = document.getElementById('tw-bld-vcount');
            if (!$list) return;
            const villages = getAllVillagesSyncB();
            if ($count) $count.textContent = villages.length;
            if (villages.length === 0) { $list.textContent = 'aguardando game_data... (ou clique ⟳ Vilas)'; return; }
            const rows = villages.slice(0, 50).map(v => {
                const s = BSTATE.villageStatuses[v.id] || { lastBuild: '-', lastRecruit: '-', lastResearch: '-', lastCoin: '-', lastSnob: '-', buildings: null, status: '-' };
                const bldStr = formatBuildingsB(s.buildings);
                const role = getVillageRoleB(v.id, villages);
                const isOverride = !!BSTATE.rolesOverride[String(v.id)];
                const roleBadge = role === 'NOBLE'
                    ? `<span style="background:#5d1f7a;color:#fff;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:bold;">👑 NOBLE${isOverride ? '*' : ''}</span>`
                    : `<span style="background:#7a1f1f;color:#fff;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:bold;">⚔ OFF${isOverride ? '*' : ''}</span>`;
                return `<div style="border-bottom:1px dotted #ccc;padding:2px 0;">
                    ${roleBadge} <b>${v.name}</b> (${v.x}|${v.y})
                    ${s.buildings ? `<span style="color:#000;font-size:9px;font-family:monospace;"> ${bldStr}</span>` : ''}<br>
                    <span style="color:#1f5d1f;font-size:9px;">🏗 ${s.lastBuild}</span> ·
                    <span style="color:#5d1f7a;font-size:9px;">🔬 ${s.lastResearch}</span><br>
                    <span style="color:#a07000;font-size:9px;">⚜ ${s.lastCoin}</span> ·
                    <span style="color:#5d1f7a;font-size:9px;">👑 ${s.lastSnob}</span><br>
                    <span style="color:#7a4d1f;font-size:9px;">⚔ ${s.lastRecruit}</span><br>
                    <span style="color:#444;font-size:9px;">${s.status}</span>
                </div>`;
            }).join('');
            const more = villages.length > 50 ? `<div style="font-size:9px;color:#888;padding:4px;">+${villages.length - 50} vilas (mostrando 50 primeiras)</div>` : '';
            $list.innerHTML = rows + more;
        }

        function updateLogPanelB() {
            const $log = document.getElementById('tw-bld-log');
            if (!$log) return;
            $log.textContent = BSTATE.log.join('\n');
        }

        async function initB() {
            console.log('[TW-BUILD] init() v0.5.0 — URL:', location.href);
            try { injectPanelB(); }
            catch (e) { console.error('[TW-BUILD] painel falhou:', e); return; }

            // Espera game_data ficar pronto (o farm já espera, mas garante)
            const start = Date.now();
            while (Date.now() - start < 8000 && !getGameDataB()) {
                await sleepB(200);
            }
            const gd = getGameDataB();
            if (!gd) {
                logB('aguardando game_data...');
                const retry = setInterval(async () => {
                    if (getGameDataB()) {
                        clearInterval(retry);
                        const villages = await getAllVillagesB(true);
                        logB(`carregado. World: ${getGameDataB().world}, Vilas: ${villages.length}`);
                        updateVillagesPanelB();
                    }
                }, 1000);
                return;
            }
            // Dispara descoberta de vilas imediatamente (popula cache + UI)
            const villages = await getAllVillagesB(true);
            logB(`Carregado. World: ${gd.world}, Player: ${gd.player?.name}, Vilas: ${villages.length}`);
            updateVillagesPanelB();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initB);
        } else {
            initB();
        }
    })();

    } // fim mainWorldScript

    const code = '(' + mainWorldScript.toString() + ')();';
    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    console.log('[TW-FARM] script tag injetado, total bytes:', code.length);
})();
