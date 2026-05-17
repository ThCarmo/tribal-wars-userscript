// ==UserScript==
// @name         TW Farm + Build + Recruit — ThCarmo
// @namespace    https://github.com/ThCarmo/tribal-wars-userscript
// @version      0.9.0
// @description  Painel unificado arrastável. Modo BR142: farm 21CL+1Spy (≥81pop) com prioridade Loot Assistant + Build só recursos. Modo SPEED preserva tudo.
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
console.log('[TW-FARM] stub carregado v0.9.0 — injetando main world script');
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
            b.innerHTML = `✅ TW v0.9.0 ATIVO — modo: <b>${WORLD_MODE.toUpperCase()}</b> — painel unificado arrastável <span style="margin-left:20px;cursor:pointer;text-decoration:underline;" id="tw-farm-banner-close">[fechar]</span>`;
            (document.body || document.documentElement).insertAdjacentElement('afterbegin', b);
            document.getElementById('tw-farm-banner-close').onclick = () => b.remove();
        };
        if (document.body) {
            showBanner();
        } else {
            document.addEventListener('DOMContentLoaded', showBanner);
        }
        console.log('[TW-FARM] v0.9.0 carregado (script-tag bridge, main world) em', location.href);
    } catch (e) {
        console.error('[TW-FARM] banner-prova falhou:', e);
    }

    // ===== WORLD MODE =====
    // 'br142'  → mundo normal: farm 21CL+1Spy (≥81 pop), prioriza pelo Loot Assistant,
    //             build SÓ recursos (wood/stone/iron até 30). Sem recruit/research/coin/snob/ataques.
    // 'speed'  → mundo speed (brs1 etc): TUDO habilitado (farm light + build/recruit/
    //             research/coin/snob/ataques). Templates universais OFF/NOBLE ativos.
    // Trocar este valor pra alternar entre os modos. Painel se adapta sozinho.
    const WORLD_MODE = 'br142';

    const CFG = {
        radiusMax: 35,
        cooldownMin: 30,
        jitterMs: [3000, 7000],
        template: 'A',
        // Pacote de tropa por ataque (mudou em v0.9.0 — mundo 142 exige ≥81 pop por farm).
        //  21 CL × 4 pop = 84 pop ≥ 81 ✓ ;  1 spy = 2 pop. Total 86 pop, 1 build, 5600 carga.
        attackUnits: { light: 21, spy: 1 },
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

            if (STATE.troopsAtHome.light < CFG.attackUnits.light) {
                STATE.lastError = `CL em casa: ${STATE.troopsAtHome.light} (precisa ≥${CFG.attackUnits.light})`;
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
                    STATE.troopsAtHome.light -= CFG.attackUnits.light;
                    STATE.troopsAtHome.spy -= CFG.attackUnits.spy;
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

    // ============ LOOT ASSISTANT — status por barb (v0.9.0) ============
    // Lê a tabela do Assistente de Saque do próprio jogo (/game.php?screen=am_farm)
    // e extrai o status visual por aldeia:
    //   🟢 full     — última volta retornou cheia (mais saque esperando)
    //   🟡 partial  — última volta retornou parcial
    //   🔴 empty    — última volta retornou vazia OU caveira (perdeu tropa)
    //   ⚪ unknown  — nunca atacou OU não encontrado
    //
    // O LA pagina os resultados. Tentamos forçar &Sb_per_page=1000 pra trazer
    // tudo de uma vez. Se o mundo não respeitar, ainda funciona com a página 1.
    //
    // Retorna: { '12345': 'full', '67890': 'partial', ... }  (key = village id)
    // Em erro, retorna {} (todos viram 'unknown' lá no caller, fluxo continua).

    async function fetchLootAssistantStatus() {
        const map = {};
        // Heurística de URL: força per_page alto pra trazer tudo numa request só.
        // Em mundos onde o LA não respeita, ainda traz a primeira página (~30 linhas).
        const url = '/game.php?screen=am_farm&order=distance&dir=asc&Farm_page=0&Farm_per_page=1000';
        let html;
        try {
            const resp = await fetch(url, { credentials: 'same-origin' });
            if (!resp.ok) {
                log(`Loot Assistant: HTTP ${resp.status} em ${url}`);
                return map;
            }
            html = await resp.text();
        } catch (e) {
            log('Loot Assistant: erro de rede:', e.message || e);
            return map;
        }
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Tenta achar a tabela de saque. IDs/classes mudam entre versões do TW.
        // Lista candidatos do mais específico pro mais genérico.
        const table = doc.querySelector(
            '#plunder_list, table.vis.plunder_list, table#scavenge_table, table.vis'
        );
        if (!table) {
            log('Loot Assistant: tabela não encontrada (HTML inesperado, talvez LA não habilitado)');
            return map;
        }

        const rows = table.querySelectorAll('tr');
        let counted = 0;
        rows.forEach(tr => {
            // Tenta extrair o village id de várias formas:
            //   1) data-id no <tr>
            //   2) link href contendo target=NNN ou id=NNN
            let id = tr.getAttribute('data-id') || tr.getAttribute('data-village-id');
            if (!id) {
                const link = tr.querySelector('a[href*="target="], a[href*="village="]');
                if (link) {
                    const m = link.getAttribute('href').match(/[?&](?:target|village)=(\d+)/);
                    if (m) id = m[1];
                }
            }
            if (!id) return;

            // Detecta status pela presença de imagem/ícone dot.
            //   imagens TW: dots/green.png, yellow.png, red.png, grey.png
            //   ou classes: dot-img green / report_y_yes etc.
            const html = tr.innerHTML;
            let status = null;
            if (/dots\/green|\bgreen\.png|status_green|report_y_yes/i.test(html)) status = 'full';
            else if (/dots\/yellow|\byellow\.png|status_yellow|report_y_partial/i.test(html)) status = 'partial';
            else if (/dots\/red|\bred\.png|status_red|report_y_no/i.test(html)) status = 'empty';
            else if (/dots\/grey|dots\/gray|\bgrey\.png|\bgray\.png/i.test(html)) status = 'unknown';

            if (status) {
                map[String(id)] = status;
                counted++;
            }
        });

        log(`Loot Assistant: ${counted} barbs com status conhecido (de ${rows.length} linhas).`);
        return map;
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
    // Itera barbáros do último scan, dispara CFG.attackUnits (21CL+1Spy em br142)
    // em cada via sendFarmViaPlace().
    // Em v0.9.0 enriquece a lista com status do Loot Assistant (🟢/🟡/⚪) e
    // re-ordena: cheias por distância → parciais por distância → desconhecidas → vazias.
    // Reaproveita guard-rails do farm: cooldown, estoque baixo, captcha, erro do servidor.

    async function mapScanFarmAll() {
        const barbsOrig = STATE.mapScanLast && STATE.mapScanLast.barbs;
        if (!barbsOrig || barbsOrig.length === 0) {
            STATE.mapScanProgress = 'rode 🔍 Buscar Barbs primeiro';
            updatePanel(null);
            return;
        }

        // Auto-resync: se inputs do painel estão zerados, tenta ler do jogo antes de barrar.
        if (STATE.troopsAtHome.light < CFG.attackUnits.light || STATE.troopsAtHome.spy < CFG.attackUnits.spy) {
            log('Map farm: estoque zerado nos inputs, tentando syncTroopsAtHome()...');
            syncTroopsAtHome();
            const $l = document.getElementById('tw-farm-light');
            const $s = document.getElementById('tw-farm-spy');
            if ($l) $l.value = STATE.troopsAtHome.light;
            if ($s) $s.value = STATE.troopsAtHome.spy;
        }
        if (STATE.troopsAtHome.light < CFG.attackUnits.light || STATE.troopsAtHome.spy < CFG.attackUnits.spy) {
            STATE.mapScanProgress = `estoque ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy < min(${CFG.attackUnits.light},${CFG.attackUnits.spy}). Preencha os campos manualmente e tente de novo.`;
            updatePanel(STATE.mapScanProgress);
            log('Map farm abortado:', STATE.mapScanProgress);
            return;
        }

        // ===== PRIORIZAÇÃO via Loot Assistant (v0.9.0) =====
        // Lê o status de cada barb (cheia 🟢 / parcial 🟡 / desconhecida ⚪ / vazia 🔴)
        // pelo Assistente de Saque do próprio jogo e reordena a lista de alvos.
        STATE.mapScanProgress = 'consultando Loot Assistant pra priorizar alvos...';
        updatePanel(STATE.mapScanProgress);
        const laStatus = await fetchLootAssistantStatus().catch(e => {
            log('Loot Assistant falhou:', e.message || e);
            return {};
        });
        const PRIO = { full: 0, partial: 1, unknown: 2, empty: 3 };
        const barbs = barbsOrig
            .map(b => ({ ...b, laStatus: laStatus[String(b.id)] || 'unknown' }))
            .sort((a, b) => {
                const pa = PRIO[a.laStatus] ?? 2;
                const pb = PRIO[b.laStatus] ?? 2;
                if (pa !== pb) return pa - pb;
                return a.dist - b.dist;  // empate → mais próximo
            });
        const laCounts = barbs.reduce((acc, b) => { acc[b.laStatus] = (acc[b.laStatus] || 0) + 1; return acc; }, {});
        log(`LA status: 🟢 ${laCounts.full || 0} cheias · 🟡 ${laCounts.partial || 0} parciais · ⚪ ${laCounts.unknown || 0} desconhecidas · 🔴 ${laCounts.empty || 0} vazias`);

        STATE.mapScanRunning = true;
        let attempted = 0, sent = 0, skippedCooldown = 0, skippedEmpty = 0, errors = 0;
        log(`Map farm: iniciando sobre ${barbs.length} alvos. Estoque: ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy. Pacote: ${CFG.attackUnits.light}CL+${CFG.attackUnits.spy}Spy`);

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
            if (STATE.troopsAtHome.light < CFG.attackUnits.light || STATE.troopsAtHome.spy < CFG.attackUnits.spy) {
                STATE.lastError = `estoque baixo: ${STATE.troopsAtHome.light}CL / ${STATE.troopsAtHome.spy}spy`;
                STATE.mapScanRunning = false;
                break;
            }
            if (isOnCooldown(b.id)) {
                skippedCooldown++;
                continue;
            }
            // Pula barbs marcadas como vazias no LA — desperdício mandar tropa
            if (b.laStatus === 'empty') {
                skippedEmpty++;
                continue;
            }

            attempted++;
            const laIcon = { full: '🟢', partial: '🟡', unknown: '⚪', empty: '🔴' }[b.laStatus] || '⚪';
            STATE.nextTarget = `${laIcon} (${b.x}|${b.y}) ${b.dist.toFixed(1)}c`;
            STATE.mapScanProgress = `${sent} enviados / ${attempted} tentativas, alvo ${STATE.nextTarget}`;
            updatePanel(STATE.mapScanProgress);

            const res = await sendFarmViaPlace(b.id, CFG.attackUnits.light, CFG.attackUnits.spy, false);

            if (res.ok) {
                sent++;
                STATE.sent++;
                STATE.troopsAtHome.light -= CFG.attackUnits.light;
                STATE.troopsAtHome.spy -= CFG.attackUnits.spy;
                STATE.lastFarmByTarget[b.id] = serverTime();
                lsSet(LS_KEY, STATE.lastFarmByTarget);
                log(`Map farm #${sent}: ${laIcon} (${b.x}|${b.y}) ok, estoque ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}spy`);
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
        STATE.mapScanProgress = `parado: ${sent} enviados, ${errors} erros, ${skippedCooldown} em cooldown, ${skippedEmpty} vazias puladas. Razão: ${STATE.lastError || 'fim da lista'}`;
        updatePanel(STATE.mapScanProgress);
        log('Map farm finalizado:', STATE.mapScanProgress);
    }

    function injectPanel() {
        if (document.getElementById('tw-farm-panel')) return;

        // Posição salva (drag). Default canto sup direito, à 10px da borda.
        const savedPos = lsGet('twFarmPanelPos', null);
        const initLeft = savedPos && Number.isFinite(savedPos.left) ? savedPos.left : Math.max(0, window.innerWidth - 290);
        const initTop  = savedPos && Number.isFinite(savedPos.top)  ? savedPos.top  : 120;
        const savedCollapsed = lsGet('twFarmPanelCollapsed', false);

        const panel = document.createElement('div');
        panel.id = 'tw-farm-panel';
        panel.style.cssText = `position:fixed;top:${initTop}px;left:${initLeft}px;z-index:99999;background:#f4e4bc;border:2px solid #603000;font-family:Verdana,Arial;font-size:11px;width:270px;box-shadow:2px 2px 8px rgba(0,0,0,0.4);border-radius:3px;`;

        const modeBadge = WORLD_MODE === 'br142'
            ? '<span style="background:#1f5d1f;color:#fff;padding:1px 5px;border-radius:2px;font-size:9px;">BR142</span>'
            : '<span style="background:#5d1f7a;color:#fff;padding:1px 5px;border-radius:2px;font-size:9px;">SPEED</span>';

        // Bloco Build Recursos — só aparece em modo br142.
        const buildSection = WORLD_MODE === 'br142' ? `
  <hr style="border:none;border-top:1px solid #603000;margin:8px 0 6px;">
  <div style="font-weight:bold;color:#603000;margin-bottom:3px;">🏗 Build Recursos (wood/stone/iron 1→30)</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-bld-r-start" style="flex:1;background:#1f7a1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">▶ Build</button>
    <button id="tw-bld-r-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">■ Stop</button>
    <button id="tw-bld-r-once" style="flex:1;background:#444;color:white;border:none;padding:5px;cursor:pointer;font-size:10px;border-radius:2px;">▷ 1×</button>
  </div>
  <div style="font-size:10px;">Status: <span id="tw-bld-r-status">parado</span> · Ciclos: <span id="tw-bld-r-cycles">0</span></div>
  <div style="font-size:9px;color:#888;">Constrói só quando há recursos disponíveis. Sem armazém/granja/ferreiro.</div>
` : '';

        panel.innerHTML = `
<div id="tw-farm-header" style="cursor:move;background:#603000;color:#fff;padding:6px 8px;display:flex;align-items:center;gap:6px;border-radius:1px;user-select:none;">
  <span style="font-weight:bold;flex:1;">⚔ TW v0.9.0 ${modeBadge}</span>
  <button id="tw-farm-min" title="minimizar" style="background:#a07000;color:#fff;border:none;width:22px;height:18px;cursor:pointer;font-size:11px;border-radius:2px;line-height:1;">${savedCollapsed ? '➕' : '➖'}</button>
</div>
<div id="tw-farm-body" style="padding:8px;${savedCollapsed ? 'display:none;' : ''}">

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
  <div style="margin-top:3px;font-size:10px;color:#603000;">
    Pacote: <input id="tw-farm-pkg-light" type="number" value="${CFG.attackUnits.light}" min="1" max="200" style="width:42px;font-size:10px;"/>CL +
    <input id="tw-farm-pkg-spy" type="number" value="${CFG.attackUnits.spy}" min="0" max="50" style="width:42px;font-size:10px;"/>Spy
    <span style="color:#888;font-size:9px;">(≥81 pop em BR142)</span>
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
  <div style="font-size:9px;color:#888;">Prioriza 🟢 cheias → 🟡 parciais → ⚪ desconhecidas (🔴 vazias puladas) via Loot Assistant. Para em estoque baixo / captcha / 5 erros.</div>
${buildSection}
  <hr style="border:none;border-top:1px solid #603000;margin:8px 0 6px;">

  <div style="font-weight:bold;color:#603000;margin-bottom:3px;">🛡 Incoming Tagger</div>
  <div style="display:flex;gap:4px;margin-bottom:4px;">
    <button id="tw-tagger-run" style="flex:1;background:#1f4d7a;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">⟳ Analisar</button>
    <button id="tw-tagger-stop" style="flex:1;background:#7a1f1f;color:white;border:none;padding:5px;cursor:pointer;font-weight:bold;border-radius:2px;">■ STOP</button>
  </div>
  <div style="font-size:10px;">Status: <span id="tw-tagger-status">ocioso</span></div>
</div>`;
        document.body.appendChild(panel);

        // ===== Drag handlers (v0.9.0) =====
        // Mousedown no header → captura offset, mousemove anexado ao document
        // pra continuar tracking mesmo se cursor sair do painel, mouseup solta.
        // Posição final persiste em localStorage.
        (function setupDrag() {
            const header = document.getElementById('tw-farm-header');
            if (!header) return;
            let dragging = false, offX = 0, offY = 0;
            header.addEventListener('mousedown', (ev) => {
                // ignora clique no botão minimizar
                if (ev.target.id === 'tw-farm-min') return;
                dragging = true;
                const rect = panel.getBoundingClientRect();
                offX = ev.clientX - rect.left;
                offY = ev.clientY - rect.top;
                ev.preventDefault();
            });
            document.addEventListener('mousemove', (ev) => {
                if (!dragging) return;
                const newLeft = Math.max(0, Math.min(window.innerWidth - 50, ev.clientX - offX));
                const newTop  = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - offY));
                panel.style.left = newLeft + 'px';
                panel.style.top  = newTop + 'px';
                // limpa o "right" antigo (style cssText pode tê-lo)
                panel.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                const rect = panel.getBoundingClientRect();
                lsSet('twFarmPanelPos', { left: Math.round(rect.left), top: Math.round(rect.top) });
            });
        })();

        // ===== Minimize handler =====
        document.getElementById('tw-farm-min').onclick = () => {
            const body = document.getElementById('tw-farm-body');
            const btn = document.getElementById('tw-farm-min');
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            btn.textContent = isHidden ? '➖' : '➕';
            lsSet('twFarmPanelCollapsed', !isHidden);
        };

        // ===== Build Recursos handlers (só em br142) =====
        if (WORLD_MODE === 'br142') {
            const $bldStart = document.getElementById('tw-bld-r-start');
            const $bldStop  = document.getElementById('tw-bld-r-stop');
            const $bldOnce  = document.getElementById('tw-bld-r-once');
            const $bldStatus = document.getElementById('tw-bld-r-status');
            const $bldCycles = document.getElementById('tw-bld-r-cycles');

            const refreshBuildStatus = () => {
                if (!w.TW_BUILD_status) return;
                const s = w.TW_BUILD_status();
                if ($bldStatus) $bldStatus.textContent = s.running ? 'rodando' : 'parado';
                if ($bldCycles) $bldCycles.textContent = s.cycles || 0;
            };
            // Poll a cada 3s pra refletir status do build loop B.
            setInterval(refreshBuildStatus, 3000);

            $bldStart.onclick = async () => {
                if (!w.TW_BUILD_start) {
                    alert('Módulo build ainda inicializando. Tente em 2s.');
                    return;
                }
                const started = w.TW_BUILD_start();
                $bldStatus.textContent = started ? 'rodando' : 'já estava rodando';
            };
            $bldStop.onclick = () => {
                if (w.TW_BUILD_stop) w.TW_BUILD_stop();
                $bldStatus.textContent = 'parando...';
            };
            $bldOnce.onclick = async () => {
                if (!w.TW_BUILD_once) {
                    alert('Módulo build ainda inicializando. Tente em 2s.');
                    return;
                }
                $bldStatus.textContent = 'rodando 1 ciclo...';
                await w.TW_BUILD_once();
                $bldStatus.textContent = 'ciclo único concluído';
                refreshBuildStatus();
            };
        }

        function applyPanelCfg() {
            CFG.radiusMax = parseInt(document.getElementById('tw-farm-radius').value, 10) || 35;
            CFG.cooldownMin = parseInt(document.getElementById('tw-farm-cd').value, 10) || 30;
            const jmin = parseInt(document.getElementById('tw-farm-jmin').value, 10) || 3000;
            const jmax = parseInt(document.getElementById('tw-farm-jmax').value, 10) || 7000;
            CFG.jitterMs = [Math.min(jmin, jmax), Math.max(jmin, jmax)];
            STATE.troopsAtHome.light = parseInt(document.getElementById('tw-farm-light').value, 10) || 0;
            STATE.troopsAtHome.spy = parseInt(document.getElementById('tw-farm-spy').value, 10) || 0;
            const pkgL = parseInt(document.getElementById('tw-farm-pkg-light').value, 10);
            const pkgS = parseInt(document.getElementById('tw-farm-pkg-spy').value, 10);
            if (Number.isFinite(pkgL) && pkgL > 0) CFG.attackUnits.light = pkgL;
            if (Number.isFinite(pkgS) && pkgS >= 0) CFG.attackUnits.spy = pkgS;
        }
        document.getElementById('tw-farm-start').onclick = () => {
            applyPanelCfg();
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
            const res = await sendFarmViaPlace(t.id, CFG.attackUnits.light, CFG.attackUnits.spy, true);
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
            // Aplica configs atuais do painel (raio, cooldown, jitter, estoque, pacote)
            applyPanelCfg();

            const maxAtaques = Math.floor(Math.min(
                STATE.troopsAtHome.light / CFG.attackUnits.light,
                STATE.troopsAtHome.spy / CFG.attackUnits.spy
            ));
            const confirmAll = window.confirm(
                `ATACAR TODOS:\n\n` +
                `${barbs.length} barbáros no scan (raio ${STATE.mapScanLast.atRadius})\n` +
                `Estoque: ${STATE.troopsAtHome.light}CL / ${STATE.troopsAtHome.spy}spy\n` +
                `Pacote por ataque: ${CFG.attackUnits.light}CL + ${CFG.attackUnits.spy}Spy (≥81 pop)\n` +
                `Máx ataques possíveis: ${maxAtaques}\n` +
                `Prioridade: 🟢 cheias → 🟡 parciais → ⚪ desconhecidas (🔴 vazias puladas)\n` +
                `Jitter: ${CFG.jitterMs[0]}-${CFG.jitterMs[1]}ms\n` +
                `Cooldown: ${CFG.cooldownMin}min\n\n` +
                `Para em estoque baixo, captcha, ou 5 erros sem 1 sucesso. Confirma?`
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
            if (STATE.troopsAtHome.light < CFG.attackUnits.light || STATE.troopsAtHome.spy < CFG.attackUnits.spy) {
                document.getElementById('tw-map-status').textContent = `precisa ${CFG.attackUnits.light}CL+${CFG.attackUnits.spy}Spy em casa (tem ${STATE.troopsAtHome.light}CL/${STATE.troopsAtHome.spy}Spy). Use RESYNC ou ajuste manual.`;
                return;
            }
            const t = barbs[0];
            const pkg = `${CFG.attackUnits.light}L+${CFG.attackUnits.spy}S`;
            const confirm1 = window.confirm(`ATAQUE REAL: ${pkg} → (${t.x}|${t.y}) [${t.name}], dist ${t.dist.toFixed(1)}c. Confirma?`);
            if (!confirm1) {
                document.getElementById('tw-map-status').textContent = 'cancelado pelo operador';
                return;
            }
            document.getElementById('tw-map-status').textContent = `enviando ${pkg} → (${t.x}|${t.y})...`;
            const res = await sendFarmViaPlace(t.id, CFG.attackUnits.light, CFG.attackUnits.spy, false);
            console.log('%c[TW-FARM] REAL resultado:', 'color:#7a1f1f;font-weight:bold', res);
            if (res.ok) {
                STATE.troopsAtHome.light -= CFG.attackUnits.light;
                STATE.troopsAtHome.spy -= CFG.attackUnits.spy;
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
            // === Especialização de vilas (v0.8.1: TODAS uniform) ===
            // Default v0.8.1: 200 (> 100) = todas as vilas são NOBLE (template
            // universal, cunham moedas + treinam nobre + recrutam heavy).
            // Pra voltar à especialização (poucas vilas NOBLE, resto OFF heavy
            // puro), diminuir esse número no painel.
            nobleVillageCount: 200,
            debugLog: true,
        };

        // ===== ROLE CONFIGS (template, mix de tropa, whitelist de pesquisa) =====
        // OFF = vila de ataque pura, só heavy. Sem barracks, sem garage, sem academia.
        //       Foco: stable + smith + recursos máximos pra fazer heavy em massa.
        // NOBLE = vila geradora de nobre. Academia + market alto pra cunhar.
        //         Escolta mínima de heavy + spy.

        // ============ TEMPLATE UNIVERSAL ============
        // Decisão do user (v0.8.1): todas as vilas fazem tudo. So precisa de:
        //   recursos + farm + storage + smith + stable + market + academia
        // NAO constroi: barracks (sem lança/espada/axe), garage (sem
        // ariete/cat), hide (sem esconder recurso de quem ataca), wall
        // (foco ofensivo).
        // Academia (snob) maxima nivel 1 nesse mundo — academia + cunhagem
        // + treino de nobre rolam em TODAS as vilas.

        // Template ESTRITO (v0.8.1): smith 20 + snob 1 + stable 10 + pré-reqs.
        // Após completar, vila para de construir (template concluído ✓).
        // Loops de coin/snob/recruit continuam rodando normalmente.
        //
        // Pré-requisitos cobertos:
        // - smith 1 precisa: main 5 + barracks 1
        // - snob 1 precisa: main 20 + market 10 + smith 20
        // - heavy (recrutamento) precisa: stable 10 + smith pesquisou heavy
        const TEMPLATE_UNIVERSAL = [
            // Base
            ['main', 3],
            ['wood', 5], ['stone', 5], ['iron', 5],
            ['farm', 3], ['storage', 3],
            ['main', 5],
            // Habilitar ferreiro (precisa barracks 1)
            ['barracks', 1],
            ['smith', 1],
            // Recursos médios pra suportar próximos prédios
            ['wood', 10], ['stone', 10], ['iron', 10],
            ['farm', 5], ['storage', 5],
            ['main', 10],
            ['smith', 5],
            // Market (pré-req da academia)
            ['market', 1], ['market', 5],
            ['wood', 15], ['stone', 15], ['iron', 15],
            ['farm', 10], ['storage', 10],
            ['market', 10],
            // Main 20 (pré-req da academia)
            ['main', 15], ['main', 20],
            ['smith', 10],
            // Estábulo (pra recrutar heavy — pré-req heavy = stable 10 + smith pesquisado)
            ['stable', 1], ['stable', 5], ['stable', 10],
            // Recursos altos pra ferreiro 15/20 (custo alto)
            ['wood', 20], ['stone', 20], ['iron', 20],
            ['farm', 15], ['storage', 15],
            ['smith', 15],
            ['wood', 25], ['stone', 25], ['iron', 25],
            ['farm', 20], ['storage', 25],   // storage 25 = 100k cap (ferreiro 20 custa ~100k+)
            // META FINAL
            ['smith', 20],
            ['snob', 1],
            // FIM — não constrói mais nada. Coin + Snob + Recruit continuam.
        ];

        // ============ TEMPLATE RESOURCES ONLY (v0.9.0 — modo BR142) ============
        // Decisão do user (mundo 142): subir SÓ wood/stone/iron até nível máximo.
        // Sem warehouse, sem granja, sem ferreiro, sem nada. O loop build só
        // dispara quando há recursos disponíveis na vila — então o jogador farma,
        // recursos acumulam, build sobe um nível, repete.
        //
        // Intercalado por nível (wood1, stone1, iron1, wood2, stone2, iron2...)
        // pra distribuir produção uniformemente em vez de zerar 1 recurso só.
        const TEMPLATE_RESOURCES_ONLY = (() => {
            const tpl = [];
            for (let lvl = 1; lvl <= 30; lvl++) {
                tpl.push(['wood', lvl]);
                tpl.push(['stone', lvl]);
                tpl.push(['iron', lvl]);
            }
            return tpl;  // 90 entradas
        })();

        // Mix universal: HEAVY PURO. Não desperdiça pop com nada mais.
        const MIX_UNIVERSAL = { heavy: 1.0 };

        // Pesquisa: heavy (unidade principal) + spy (recon). NÃO pesquisa snob
        // — nobre é treinado direto na academia, sem pesquisa no ferreiro.
        const RESEARCH_WHITELIST = {
            OFF:   ['heavy', 'spy'],
            NOBLE: ['heavy', 'spy'],
        };

        // Aliases pra compatibilidade com código que ainda referencia OFF/NOBLE
        const TEMPLATE_OFF = TEMPLATE_UNIVERSAL;
        const TEMPLATE_NOBLE = TEMPLATE_UNIVERSAL;
        const MIX_OFF = MIX_UNIVERSAL;
        const MIX_NOBLE = MIX_UNIVERSAL;

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

        // Migration v0.8.1: nobleCount mudou de default 5 → 200 (todas viram NOBLE).
        // Se o user tem valor antigo salvo (era 5 ou menor) E nunca passou pela
        // v0.8.1, reseta pro novo default. Se mexeu manualmente pra >5, respeita.
        const LS_VERSION_KEY = 'twBuildLastSeenVersion';
        const seenVersion = lsGetB(LS_VERSION_KEY, null);
        if (seenVersion !== '0.7.4') {
            const oldCount = lsGetB(LS_NOBLE_COUNT, null);
            if (oldCount === null || oldCount <= 5) {
                // Reseta pro novo default da v0.8.1
                localStorage.removeItem(LS_NOBLE_COUNT);
            }
            lsSetB(LS_VERSION_KEY, '0.7.4');
        }

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
            // === Especialização por role (v0.8.1) ===
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
            troopsOverview: null,  // { rows, unitTypes, totals } da última busca
            troopsOverviewAt: 0,
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
                        // Limpa nome: tira coord do final ("Aldeia X (123|456)" → "Aldeia X")
                        let name = (link.textContent || `Vila ${id}`).trim();
                        const parenIdx = name.indexOf('(');
                        if (parenIdx > 0) name = name.slice(0, parenIdx).trim();
                        name = name.slice(0, 30);
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

        // ============ ATAQUE DE CONQUISTA (v0.8.1) ============
        // Localiza jogador alvo via /map/player.txt, vilas dele via /map/village.txt,
        // calcula PLANO (qual nossa vila ataca qual vila dele, com 4 NT por alvo),
        // mostra plano pra usuário confirmar, executa com guard-rails.

        const ATCFG = {
            noblesPerTarget: 4,         // ataques NT por vila do alvo
            heavyPerAttack: 500,        // escolta de heavy por NT
            spyPerAttack: 0,            // spy junto (info)
            minPauseMs: 2000,           // pausa entre disparos
            maxAttacksPerMin: 25,       // cap pra evitar captcha
        };

        const LS_ATTACK_HISTORY = 'twBuildAttackHistory';

        BSTATE.attackPlanLast = null;
        BSTATE.attackRunning = false;
        BSTATE.attackHistory = lsGetB(LS_ATTACK_HISTORY, {});

        async function fetchPlayerByNameB(name) {
            try {
                const resp = await fetch('/map/player.txt', { credentials: 'same-origin' });
                if (!resp.ok) return null;
                const text = await resp.text();
                const search = name.toLowerCase().trim();
                const matches = [];
                for (const line of text.split('\n')) {
                    if (!line) continue;
                    const parts = line.split(',');
                    if (parts.length < 4) continue;
                    let plName;
                    try { plName = decodeURIComponent(parts[1].replace(/\+/g, ' ')); }
                    catch (e) { plName = parts[1]; }
                    const lower = plName.toLowerCase();
                    if (lower === search) return { id: parts[0], name: plName, points: parseInt(parts[4]) || 0, exact: true };
                    if (lower.includes(search)) matches.push({ id: parts[0], name: plName, points: parseInt(parts[4]) || 0 });
                }
                if (matches.length === 1) return { ...matches[0], exact: false };
                if (matches.length > 1) return { matches };
                return null;
            } catch (e) {
                logB('fetchPlayerByName crashou: ' + e.message);
                return null;
            }
        }

        async function fetchVillagesOfPlayerB(playerId) {
            try {
                const resp = await fetch('/map/village.txt', { credentials: 'same-origin' });
                if (!resp.ok) return [];
                const text = await resp.text();
                const villages = [];
                for (const line of text.split('\n')) {
                    if (!line) continue;
                    const parts = line.split(',');
                    if (parts.length < 7) continue;
                    if (parts[4] !== String(playerId)) continue;
                    let name;
                    try { name = decodeURIComponent(parts[1].replace(/\+/g, ' ')); }
                    catch (e) { name = parts[1]; }
                    villages.push({
                        id: parts[0], name: name.slice(0, 30),
                        x: parseInt(parts[2]), y: parseInt(parts[3]),
                        points: parseInt(parts[5]) || 0,
                    });
                }
                return villages;
            } catch (e) {
                logB('fetchVillagesOfPlayer crashou: ' + e.message);
                return [];
            }
        }

        async function sendAttackViaPlaceB(sourceVillageId, targetX, targetY, units, dryRun = false) {
            // Flow 3-step padrão da Praça do TW.
            // units = { snob: 1, heavy: 500, spy: 0, ... }
            // Retorna { ok, error?, dryRun?, body? }
            const parser = new DOMParser();
            const url1 = `/game.php?village=${sourceVillageId}&screen=place`;
            let r1;
            try { r1 = await fetch(url1, { credentials: 'same-origin' }); }
            catch (e) { return { ok: false, error: 'rede step1: ' + e.message }; }
            if (!r1.ok) return { ok: false, error: `HTTP ${r1.status} step1` };
            const html1 = await r1.text();
            const doc1 = parser.parseFromString(html1, 'text/html');
            const form1 = doc1.querySelector('form#command-data-form, form[action*="screen=place"], form[name="form_command"]');
            if (!form1) return { ok: false, error: 'step1 sem form (praça não construída?)' };
            const hInput = form1.querySelector('input[name="h"]');
            const h = hInput ? hInput.value : (parseCsrfB(doc1) || '');
            if (!h) return { ok: false, error: 'CSRF não encontrado' };

            const fd2 = new FormData();
            form1.querySelectorAll('input[type=hidden]').forEach(inp => {
                if (inp.name) fd2.append(inp.name, inp.value || '');
            });
            fd2.set('x', String(targetX));
            fd2.set('y', String(targetY));
            const allUnits = ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','militia','snob'];
            for (const u of allUnits) fd2.set(u, String(units[u] || 0));
            fd2.set('attack', 'l');
            fd2.set('h', h);

            if (dryRun) {
                const body = {};
                for (const [k, v] of fd2.entries()) body[k] = v;
                return { ok: true, dryRun: true, body };
            }

            const url2 = `/game.php?village=${sourceVillageId}&screen=place&try=confirm&h=${h}`;
            let r2;
            try { r2 = await fetch(url2, { method: 'POST', body: fd2, credentials: 'same-origin' }); }
            catch (e) { return { ok: false, error: 'rede step2: ' + e.message }; }
            const html2 = await r2.text();
            const doc2 = parser.parseFromString(html2, 'text/html');
            const errBox2 = doc2.querySelector('.error_box');
            if (errBox2) return { ok: false, error: 'step2: ' + errBox2.textContent.trim().slice(0,150) };
            const form2 = doc2.querySelector('form#command-data-form, form[id*="command"], form[action*="action=command"]');
            if (!form2) return { ok: false, error: 'step2: form de confirmação não retornou' };

            const fd3 = new FormData();
            form2.querySelectorAll('input').forEach(inp => {
                if (inp.name && inp.type !== 'submit') fd3.append(inp.name, inp.value || '');
            });
            fd3.set('attack', 'true');

            const action3 = form2.getAttribute('action') || `/game.php?village=${sourceVillageId}&screen=place&action=command&h=${h}`;
            let r3;
            try { r3 = await fetch(action3, { method: 'POST', body: fd3, credentials: 'same-origin' }); }
            catch (e) { return { ok: false, error: 'rede step3: ' + e.message }; }
            const html3 = await r3.text();
            if (html3.includes('command_id') || html3.includes('screen=info_command') ||
                html3.includes('overview_villages') || /comando.*sucesso/i.test(html3)) {
                return { ok: true };
            }
            const doc3 = parser.parseFromString(html3, 'text/html');
            const err3 = doc3.querySelector('.error_box');
            if (err3) return { ok: false, error: 'step3: ' + err3.textContent.trim().slice(0,150) };
            return { ok: false, error: 'step3: resposta ambígua' };
        }

        async function planConquestB(playerName) {
            // 1) Resolve jogador
            const pl = await fetchPlayerByNameB(playerName);
            if (!pl) { alert(`Jogador "${playerName}" não encontrado em /map/player.txt`); return null; }
            if (pl.matches) {
                const list = pl.matches.slice(0, 10).map((m, i) => `${i+1}) ${m.name} (id ${m.id}, ${m.points} pts)`).join('\n');
                alert(`Várias correspondências pra "${playerName}":\n\n${list}\n\nDigite o nome EXATO no próximo prompt.`);
                return null;
            }
            // 2) Vilas do alvo
            const targets = await fetchVillagesOfPlayerB(pl.id);
            if (targets.length === 0) { alert(`${pl.name} sem vilas ativas no mapa`); return null; }

            // 3) Verifica que tropas atuais foram puxadas
            if (!BSTATE.troopsOverview || !BSTATE.troopsOverview.rows) {
                alert('Rode "📊 Tropas" primeiro pra eu saber quem tem nobre/heavy disponível.');
                return null;
            }
            const troopsById = {};
            BSTATE.troopsOverview.rows.forEach(r => { troopsById[r.villageId] = r.units || {}; });

            // 4) Pra cada vila do alvo, escolhe N nossas vilas com nobre+heavy
            const ourVillages = await getAllVillagesB();
            const noblesUsed = {};  // {ourVillageId: count}
            const plan = [];
            let skipped = 0;
            targets.sort((a, b) => a.points - b.points);  // ataca menor primeiro

            for (const target of targets) {
                for (let i = 0; i < ATCFG.noblesPerTarget; i++) {
                    const candidates = ourVillages
                        .map(v => {
                            const units = troopsById[v.id] || {};
                            return {
                                ...v, units,
                                dist: Math.sqrt((v.x - target.x)**2 + (v.y - target.y)**2),
                                noblesLeft: (units.snob || 0) - (noblesUsed[v.id] || 0),
                                heavyLeft: (units.heavy || 0) - ((noblesUsed[v.id] || 0) * ATCFG.heavyPerAttack),
                            };
                        })
                        .filter(v => v.noblesLeft >= 1 && v.heavyLeft >= ATCFG.heavyPerAttack)
                        .sort((a, b) => a.dist - b.dist);
                    if (candidates.length === 0) { skipped++; continue; }
                    const best = candidates[0];
                    noblesUsed[best.id] = (noblesUsed[best.id] || 0) + 1;
                    plan.push({
                        target, source: { id: best.id, name: best.name, x: best.x, y: best.y },
                        ataque: i + 1, dist: best.dist,
                        units: { snob: 1, heavy: ATCFG.heavyPerAttack, spy: ATCFG.spyPerAttack },
                    });
                }
            }
            return { player: pl, targets, plan, skipped };
        }

        async function executeConquestPlanB(plan) {
            if (WORLD_MODE !== 'speed') {
                logB('Ataques de conquista DESATIVADOS em modo ' + WORLD_MODE + '.');
                return;
            }
            BSTATE.attackRunning = true;
            let sent = 0, errors = 0;
            const startMs = Date.now();
            for (const item of plan) {
                if (!BSTATE.attackRunning) { logB('Ataque parado pelo usuário'); break; }
                // Rate limiting: max N ataques por minuto
                const elapsedMin = (Date.now() - startMs) / 60000;
                if (sent / Math.max(elapsedMin, 1/60) > ATCFG.maxAttacksPerMin) {
                    logB(`Rate limit ${ATCFG.maxAttacksPerMin}/min — pausando 10s`);
                    await sleepB(10000);
                }
                logB(`Disparando #${sent+1}/${plan.length}: vila ${item.source.name} → ${item.target.name} (${item.target.x}|${item.target.y}) NT+${item.units.heavy}CP`);
                const res = await sendAttackViaPlaceB(item.source.id, item.target.x, item.target.y, item.units, false);
                if (res.ok) {
                    sent++;
                    BSTATE.attackHistory[item.target.id] = (BSTATE.attackHistory[item.target.id] || 0) + 1;
                    lsSetB(LS_ATTACK_HISTORY, BSTATE.attackHistory);
                } else {
                    errors++;
                    logB(`  ❌ FALHOU: ${res.error}`);
                    if (/captcha|bot/i.test(res.error || '')) {
                        BSTATE.attackRunning = false;
                        logB('🛑 CAPTCHA/BOT detectado — parando');
                        break;
                    }
                    if (errors >= 5 && sent === 0) {
                        BSTATE.attackRunning = false;
                        logB('🛑 5 erros sem 1 sucesso — abortando pra investigar');
                        break;
                    }
                }
                await sleepB(ATCFG.minPauseMs + Math.floor(Math.random() * 1000));
            }
            BSTATE.attackRunning = false;
            logB(`Conquista terminada: ${sent} disparados, ${errors} erros`);
            alert(`Conquista terminada:\n\n✅ ${sent} ataques disparados\n❌ ${errors} erros\n\nConfere em /game.php?screen=overview_villages&mode=commands`);
        }

        // ===== TROPAS (overview/units) =====
        // Endpoint /game.php?screen=overview_villages&mode=units lista as tropas
        // de TODAS as vilas do jogador numa tabela só. Mais barato que iterar
        // cada vila fetchando stable/barracks/garage.

        // Mapeamento PT-BR → unit ID (fallback quando header não tem class unit-item-*)
        const UNIT_NAME_TO_ID = {
            'lanceiro': 'spear', 'lança': 'spear', 'lanca': 'spear',
            'espadachim': 'sword', 'espada': 'sword',
            'bárbaro': 'axe', 'barbaro': 'axe', 'machadeiro': 'axe',
            'arqueiro': 'archer', 'arq': 'archer',
            'explorador': 'spy', 'espião': 'spy', 'espiao': 'spy',
            'cavalaria leve': 'light', 'cav leve': 'light',
            'arqueiro montado': 'marcher', 'arq mont': 'marcher',
            'cavalaria pesada': 'heavy', 'paladino pesado': 'heavy', 'cav pesada': 'heavy',
            'ariete': 'ram', 'aríete': 'ram',
            'catapulta': 'catapult',
            'paladino': 'knight', 'cavaleiro': 'knight',
            'nobre': 'snob', 'apóstolo': 'snob', 'apostolo': 'snob',
            'milícia': 'militia', 'milicia': 'militia',
        };

        async function fetchTroopsOverviewB() {
            // Tenta várias URLs e modos
            const urls = [
                '/game.php?screen=overview_villages&mode=units',
                '/game.php?screen=overview_villages&mode=units&group=0&page=-1',  // todas as páginas
                '/game.php?screen=overview_villages&mode=combined',
            ];
            for (const url of urls) {
                try {
                    const resp = await fetch(url, { credentials: 'same-origin' });
                    if (!resp.ok) continue;
                    const html = await resp.text();
                    // Salva pra inspeção/debug
                    wB.TW_BUILD_TROOPS_RAW_HTML = html.slice(0, 50000);
                    wB.TW_BUILD_TROOPS_RAW_URL = url;
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const result = parseTroopsTableB(doc);
                    logB(`tropas ${url} → ${result.rows.length} linhas, ${result.unitTypes.length} unidades detectadas: [${result.unitTypes.join(',')}]`);
                    if (result.rows.length > 0 && result.unitTypes.length > 0) {
                        // Agrega multi-linhas por vila (se a tabela mostra "em casa" + "fora")
                        const aggregated = aggregateRowsByVillageB(result.rows);
                        const totals = {};
                        aggregated.forEach(r => {
                            for (const [u, n] of Object.entries(r.units)) {
                                totals[u] = (totals[u] || 0) + n;
                            }
                        });
                        return { rows: aggregated, unitTypes: result.unitTypes, totals, url };
                    }
                } catch (e) {
                    logB(`tropas ${url} crashou: ${e.message}`);
                }
            }
            return { rows: [], unitTypes: [], totals: {} };
        }

        function aggregateRowsByVillageB(rows) {
            // Se a tabela tem múltiplas linhas pra mesma vila (em casa / em comando /
            // em apoio), soma tudo num único registro por vila.
            const byId = {};
            rows.forEach(r => {
                if (!byId[r.villageId]) {
                    byId[r.villageId] = { villageId: r.villageId, name: r.name, units: {} };
                }
                for (const [u, n] of Object.entries(r.units)) {
                    byId[r.villageId].units[u] = (byId[r.villageId].units[u] || 0) + n;
                }
            });
            return Object.values(byId);
        }

        function detectUnitsFromHeaderB(table) {
            // Procura unidades em várias estratégias e na ORDEM em que aparecem nas colunas.
            // Retorna array [unitId | null]  — null pra colunas que não são unidade.
            const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
            if (!headerRow) return [];
            const cells = headerRow.querySelectorAll('th, td');
            const units = [];
            cells.forEach(th => {
                const html = th.innerHTML || '';
                // 1. class unit-item-NAME
                let m = html.match(/unit-item-([a-z]+)/i);
                if (m) { units.push(m[1].toLowerCase()); return; }
                // 2. unit_image NAME
                m = html.match(/unit_image\s+([a-z]+)/i) || html.match(/class=["'][^"']*\b([a-z]+)\s+unit[^"']*["']/i);
                if (m) { units.push(m[1].toLowerCase()); return; }
                // 3. img src=unit_NAME.png
                const img = th.querySelector('img');
                if (img) {
                    const src = img.getAttribute('src') || '';
                    const alt = (img.getAttribute('alt') || '').toLowerCase();
                    const title = (img.getAttribute('title') || '').toLowerCase();
                    let m2 = src.match(/unit_([a-z]+)\.png/i);
                    if (m2) { units.push(m2[1].toLowerCase()); return; }
                    // 4. alt PT-BR
                    for (const [name, id] of Object.entries(UNIT_NAME_TO_ID)) {
                        if (alt === name || title === name || alt.includes(name) || title.includes(name)) {
                            units.push(id); return;
                        }
                    }
                }
                // 5. texto da célula em PT-BR
                const txt = (th.textContent || '').toLowerCase().trim();
                for (const [name, id] of Object.entries(UNIT_NAME_TO_ID)) {
                    if (txt === name || txt.startsWith(name)) { units.push(id); return; }
                }
                // Não é coluna de unidade
                units.push(null);
            });
            return units;
        }

        function parseTroopsTableB(doc) {
            const result = { rows: [], unitTypes: [], totals: {} };
            // Procura tabela específica primeiro
            let table = doc.querySelector('#units_table, table.vis.units_table');
            if (!table) {
                // Fallback: maior tabela com link village= no tbody
                let best = null, bestCount = 0;
                doc.querySelectorAll('table').forEach(t => {
                    const c = t.querySelectorAll('tbody tr a[href*="village="]').length;
                    if (c > bestCount) { bestCount = c; best = t; }
                });
                table = best;
            }
            if (!table) return result;

            // Detecta colunas pelo header
            const columnUnits = detectUnitsFromHeaderB(table);
            const validUnits = columnUnits.filter(u => u != null);
            result.unitTypes = [...new Set(validUnits)];

            if (validUnits.length === 0) {
                logB('parseTroopsTable: nenhum header de unidade detectado — verifique window.TW_BUILD_TROOPS_RAW_HTML');
                return result;
            }

            // Pra cada row do tbody, extrai villageId + valores das colunas que correspondem a unidades
            const dataRows = table.querySelectorAll('tbody tr');
            dataRows.forEach(row => {
                const link = row.querySelector('a[href*="village="]');
                if (!link) return;
                const idMatch = link.href.match(/[?&]village=(\d+)/);
                if (!idMatch) return;
                const villageId = idMatch[1];
                let name = (link.textContent || '').trim();
                const parenIdx = name.indexOf('(');
                if (parenIdx > 0) name = name.slice(0, parenIdx).trim();
                name = name.slice(0, 30);

                const cells = row.querySelectorAll('td');
                const units = {};
                // Mapeia coluna -> unit usando o índice do header
                cells.forEach((td, idx) => {
                    const unit = columnUnits[idx];
                    if (!unit) return;
                    const txt = (td.textContent || '').replace(/[^\d]/g, '');
                    const n = parseInt(txt, 10);
                    if (Number.isFinite(n) && n >= 0) {
                        units[unit] = (units[unit] || 0) + n;
                    }
                });
                result.rows.push({ villageId, name, units });
            });
            return result;
        }

        function formatTroopsTotalsB(totals) {
            if (!totals || Object.keys(totals).length === 0) return '(nenhuma tropa detectada)';
            const order = ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','snob'];
            const labels = {spear:'L', sword:'E', axe:'M', archer:'A', spy:'spy', light:'CL', marcher:'AC',
                heavy:'CP', ram:'AR', catapult:'CT', knight:'PAL', snob:'NB'};
            return order.filter(u => totals[u] > 0)
                .map(u => `${labels[u] || u}:${totals[u].toLocaleString('pt-BR')}`)
                .join(' | ');
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

        function pickNextBuildB(template, current, queue, skipKeys = []) {
            const effective = { ...current };
            for (const q of queue) {
                if (!effective[q.building] || effective[q.building] < q.targetLevel) {
                    effective[q.building] = q.targetLevel;
                }
            }
            for (const [building, target] of template) {
                const cur = effective[building] || 0;
                if (cur < target) {
                    const key = `${building}:${cur + 1}`;
                    if (skipKeys.includes(key)) continue;  // já tentou e falhou nesta passada
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
                // PARSER CONSERVADOR: só erro se div.error_box explícito
                const errBoxMatch = text.match(/<div[^>]*class\s*=\s*["'][^"']*\berror_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
                if (errBoxMatch) {
                    const errText = errBoxMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 150);
                    return { ok: false, error: errText || 'error_box vazio' };
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
            // Skip list: prédios que o servidor recusou nesta passada por pré-req faltante
            // ou "totalmente construído". Faz pickNextBuild pular pro próximo do template.
            const skipKeys = [];
            // Guard: máx 10 tentativas no for (pra não infinite loop se template todo recusa)
            let attempts = 0;
            for (let slot = 0; slot < slotsAvailable; slot++) {
                if (++attempts > slotsAvailable + 10) break;
                const next = pickNextBuildB(template, current, simulatedQueue, skipKeys);
                if (!next) {
                    if (enqueuedThisPass.length === 0 && skipKeys.length === 0) {
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
                    simulatedQueue.push({ building: next.building, targetLevel: next.toLevel });
                    if (slot < slotsAvailable - 1) await sleepB(jitterB([500, 1500]));
                } else {
                    const err = res.error || '';
                    // Erros "recuperáveis" (pré-req faltando, já no max, indisponível):
                    // pula esse item do template e tenta o próximo. Não consome slot.
                    if (/poss[íi]vel|totalmente|prerequisit|nivel.+m[aá]ximo|n[íi]vel.+m[aá]ximo|construct.+max/i.test(err)) {
                        skipKeys.push(`${next.building}:${next.toLevel}`);
                        slot--; // re-tenta o mesmo slot com próximo do template
                        // Não loga cada skip (verbose demais com 100 vilas)
                        continue;
                    }
                    // Outros erros (sem recursos, captcha): para de tentar nessa vila
                    errorsThisPass.push(`${next.building}:${err}`);
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
                // PARSER CONSERVADOR: só erro se div.error_box explícito
                const errBoxMatch = text.match(/<div[^>]*class\s*=\s*["'][^"']*\berror_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
                if (errBoxMatch) {
                    const errText = errBoxMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 150);
                    return { ok: false, error: errText || 'error_box vazio', sent: amounts };
                }
                return { ok: true, sent: amounts };
            } catch (e) {
                return { ok: false, error: e.message || 'fetch crashou', sent: amounts };
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
                    // Silencia erros esperados em mundo speed (prédio ainda não construído)
                    if (!/sem form|n[ãa]o constru|sem custos/i.test(res.error || '')) {
                        logB(`Vila ${village.name} ${screen} falhou: ${res.error}`);
                    }
                }
                await sleepB(jitterB());
            }
            if (summary.length > 0) {
                status.lastRecruit = `${summary.join(' ')} (${nowStrB()})`;
            }
            updateVillagesPanelB();
        }

        async function recruitLoopB() {
            if (WORLD_MODE !== 'speed') {
                logB('Recruit DESATIVADO em modo ' + WORLD_MODE + ' (só recursos).');
                BSTATE.recruitRunning = false;
                return;
            }
            logB(`Recruit loop iniciado. Mix OFF=${JSON.stringify(BSTATE.mixes.OFF)} | NOBLE=${JSON.stringify(BSTATE.mixes.NOBLE)}`);
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
            if (WORLD_MODE !== 'speed') {
                logB('Research DESATIVADO em modo ' + WORLD_MODE + '.');
                BSTATE.researchRunning = false;
                return;
            }
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
                // PARSER CONSERVADOR: só considera erro se achar div.error_box EXPLÍCITO.
                // Antes: usava regex genérico que pegava qualquer página com "recursos"
                // (label do topo) e dava falso-positivo.
                const errBoxMatch = text.match(/<div[^>]*class\s*=\s*["'][^"']*\berror_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
                if (errBoxMatch) {
                    const errText = errBoxMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 150);
                    return { ok: false, error: errText || 'error_box vazio', coinsBefore };
                }
                // Verifica se voltou a página de cunhagem com novo coin count (sucesso real)
                const newDoc = new DOMParser().parseFromString(text, 'text/html');
                const coinsAfter = parseCoinCountB(newDoc);
                return {
                    ok: true,
                    coinsBefore,
                    coinsAfter,
                    mintedRequested: amount,
                    actuallyMinted: (coinsAfter !== null && coinsBefore !== null)
                        ? Math.max(0, coinsAfter - coinsBefore) : null,
                };
            } catch (e) {
                return { ok: false, error: e.message || 'fetch crashou' };
            }
        }

        async function processVillageCoinB(village) {
            const status = ensureStatusB(village);
            if (getVillageRoleB(village.id) !== 'NOBLE') {
                status.lastCoin = 'skip (não-NOBLE)';
                return;
            }
            const res = await mintCoinsInVillageB(village.id, BCFG.coinsPerCycle || 1);
            if (res.ok) {
                const actual = res.actuallyMinted;
                if (actual !== null && actual === 0) {
                    // Não cunhou de verdade — provavelmente sem recursos. Silencioso.
                    status.lastCoin = `sem recursos? (${nowStrB()})`;
                } else {
                    const cnt = actual !== null ? actual : res.mintedRequested;
                    status.lastCoin = `+${cnt} → ${res.coinsAfter ?? '?'} (${nowStrB()})`;
                    if (actual === null || actual > 0) {
                        logB(`Vila ${village.name}: cunhou ${cnt} moeda(s) (tinha ${res.coinsBefore ?? '?'}, tem ${res.coinsAfter ?? '?'})`);
                    }
                }
            } else {
                const err = (res.error || '').trim() || 'erro vazio do servidor';
                status.lastCoin = `falhou: ${err.slice(0, 30)}`;
                if (!/academia n[ãa]o constru|sem form|n[ãa]o.+suficiente|recursos|error_box vazio/i.test(err)) {
                    logB(`Vila ${village.name} coin: ${err}`);
                }
            }
            updateVillagesPanelB();
        }

        async function coinLoopB() {
            if (WORLD_MODE !== 'speed') {
                logB('Coin DESATIVADO em modo ' + WORLD_MODE + '.');
                BSTATE.coinRunning = false;
                return;
            }
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
                // PARSER CONSERVADOR (igual coin): só erro se div.error_box explícito
                const errBoxMatch = text.match(/<div[^>]*class\s*=\s*["'][^"']*\berror_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
                if (errBoxMatch) {
                    const errText = errBoxMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 150);
                    return { ok: false, error: errText || 'error_box vazio' };
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e.message || 'fetch crashou' };
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
                if (!/sem form|n[ãa]o constru/i.test(res.error || '')) {
                    logB(`Vila ${village.name} snob: ${res.error}`);
                }
            }
            updateVillagesPanelB();
        }

        async function snobLoopB() {
            if (WORLD_MODE !== 'speed') {
                logB('Snob DESATIVADO em modo ' + WORLD_MODE + '.');
                BSTATE.snobRunning = false;
                return;
            }
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
    <button id="tw-bld-troops" style="background:#7a4d1f;color:white;border:none;padding:2px 6px;cursor:pointer;font-size:10px;border-radius:2px;" title="Contar todas as tropas em todas as vilas">📊 Tropas</button>
  </div>
  <div id="tw-bld-troops-display" style="background:#fff8e0;border:1px solid #a07000;padding:5px;margin-bottom:6px;font-size:10px;border-radius:2px;display:none;">
    <b>📊 Tropas totais:</b> <span id="tw-bld-troops-totals">clique 📊 Tropas pra atualizar</span>
    <div style="font-size:9px;color:#666;margin-top:2px;" id="tw-bld-troops-meta"></div>
  </div>

  <div style="background:#3d0a0a;color:#fff;border:2px solid #7a1f1f;padding:6px;margin-bottom:6px;border-radius:2px;">
    <div style="font-weight:bold;margin-bottom:4px;">🎯 Conquistar Jogador (v0.8.1)</div>
    <div style="display:flex;gap:4px;">
      <button id="tw-atk-plan" style="flex:2;background:#a02020;color:white;border:none;padding:6px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">📋 Planejar Ataque</button>
      <button id="tw-atk-stop" style="flex:1;background:#444;color:white;border:none;padding:6px;cursor:pointer;font-weight:bold;border-radius:2px;font-size:11px;">🛑 STOP</button>
    </div>
    <div style="font-size:9px;color:#ccc;margin-top:4px;">Status: <span id="tw-atk-status">ocioso</span></div>
    <div style="font-size:9px;color:#ccc;">Cuidado: dispara ataques REAIS. Sempre confirma o plano antes.</div>
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
            document.getElementById('tw-atk-stop').onclick = () => {
                BSTATE.attackRunning = false;
                document.getElementById('tw-atk-status').textContent = 'parando após disparo atual...';
            };

            document.getElementById('tw-atk-plan').onclick = async () => {
                const $status = document.getElementById('tw-atk-status');
                if (BSTATE.attackRunning) {
                    alert('Já tem ataque rodando. Use STOP primeiro.');
                    return;
                }
                if (!BSTATE.troopsOverview || !BSTATE.troopsOverview.rows) {
                    alert('Rode "📊 Tropas" primeiro pra eu saber quem tem nobre + heavy disponível.');
                    return;
                }

                const playerName = prompt(
                    'Nome do jogador alvo (busca em /map/player.txt):\n\n' +
                    'Ex: "Luis Fuerza", "luis", etc.\n' +
                    'Se houver várias correspondências, vou pedir o nome exato.'
                );
                if (!playerName || !playerName.trim()) return;

                $status.textContent = 'buscando jogador + planejando...';
                const result = await planConquestB(playerName.trim());
                if (!result) { $status.textContent = 'plano cancelado'; return; }

                BSTATE.attackPlanLast = result;
                wB.TW_ATTACK_PLAN = result;

                const totalAttacks = result.plan.length;
                const totalNobles = result.plan.length;
                const totalHeavy = result.plan.reduce((s, p) => s + (p.units.heavy || 0), 0);
                const sourcesUsed = new Set(result.plan.map(p => p.source.id)).size;
                const distAvg = result.plan.length > 0
                    ? (result.plan.reduce((s, p) => s + p.dist, 0) / result.plan.length).toFixed(1)
                    : '0';

                // Resumo por vila do alvo
                const perTarget = {};
                result.plan.forEach(p => {
                    perTarget[p.target.id] = perTarget[p.target.id] || { name: p.target.name, coord: `(${p.target.x}|${p.target.y})`, count: 0 };
                    perTarget[p.target.id].count++;
                });
                const targetCoverage = Object.values(perTarget);
                const fullyCovered = targetCoverage.filter(t => t.count >= ATCFG.noblesPerTarget).length;
                const partial = targetCoverage.filter(t => t.count > 0 && t.count < ATCFG.noblesPerTarget).length;
                const uncovered = result.targets.length - targetCoverage.length;

                console.log('%c═══ PLANO DE CONQUISTA ═══', 'color:#a02020;font-size:14px;font-weight:bold');
                console.log('Alvo:', result.player);
                console.log('Vilas do alvo:', result.targets);
                console.log('Plano:', result.plan);
                console.table(result.plan.map(p => ({
                    alvo: `${p.target.name} (${p.target.x}|${p.target.y})`,
                    nossa: p.source.name, dist: p.dist.toFixed(1),
                    ataque: `${p.ataque}/${ATCFG.noblesPerTarget}`,
                    NT: p.units.snob, CP: p.units.heavy,
                })));

                const summary =
                    `🎯 PLANO DE CONQUISTA — ${result.player.name} (id ${result.player.id})\n\n` +
                    `🏘 ${result.targets.length} vilas do alvo (${result.player.points} pts)\n` +
                    `📋 ${totalAttacks} ataques planejados (${ATCFG.noblesPerTarget} por vila ideal)\n` +
                    `  ✅ ${fullyCovered} vilas com cobertura COMPLETA (${ATCFG.noblesPerTarget} NT)\n` +
                    `  ⚠️ ${partial} vilas com cobertura PARCIAL\n` +
                    `  ❌ ${uncovered} vilas SEM cobertura (sem nossas vilas com NT+CP disponível)\n\n` +
                    `💰 Recursos: ${totalNobles} nobres + ${totalHeavy.toLocaleString('pt-BR')} CP\n` +
                    `🏰 ${sourcesUsed} nossas vilas vão disparar (dist média ${distAvg}c)\n` +
                    `⏱ Tempo estimado: ~${Math.ceil(totalAttacks * (ATCFG.minPauseMs/1000) / 60)} min (rate ${ATCFG.maxAttacksPerMin}/min)\n\n` +
                    `Detalhes completos no console (F12) — também em window.TW_ATTACK_PLAN\n\n` +
                    `CONFIRMA DISPARAR ATAQUES REAIS?\n` +
                    `(Cancelar = só visualizar plano sem disparar)`;

                if (!confirm(summary)) {
                    $status.textContent = 'plano gerado, NÃO disparado (cancelado pelo user)';
                    logB(`Plano gerado contra ${result.player.name}: ${totalAttacks} ataques. NÃO disparado.`);
                    return;
                }

                // Segunda confirmação obrigatória
                const second = prompt(
                    `⚠️ ÚLTIMA CONFIRMAÇÃO\n\nVai disparar ${totalAttacks} ataques REAIS contra ${result.player.name}.\n\n` +
                    `Pra confirmar, digite o nome do alvo EXATO:\n(esperado: "${result.player.name}")`
                );
                if (second !== result.player.name) {
                    alert('Cancelado — nome não bate.');
                    $status.textContent = 'cancelado (2ª confirmação)';
                    return;
                }

                $status.textContent = 'DISPARANDO ataques (clique STOP pra parar)...';
                logB(`🎯 INICIANDO conquista de ${result.player.name}: ${totalAttacks} ataques`);
                await executeConquestPlanB(result.plan);
                $status.textContent = 'concluído';
            };

            document.getElementById('tw-bld-troops').onclick = async () => {
                const $display = document.getElementById('tw-bld-troops-display');
                const $totals = document.getElementById('tw-bld-troops-totals');
                const $meta = document.getElementById('tw-bld-troops-meta');
                $display.style.display = 'block';
                $totals.textContent = 'buscando...';
                $meta.textContent = '';
                logB('Buscando tropas em todas as vilas...');
                const result = await fetchTroopsOverviewB();
                BSTATE.troopsOverview = result;
                BSTATE.troopsOverviewAt = Date.now();
                wB.TW_BUILD_TROOPS = result;  // pra inspecionar no console
                const totalUnits = Object.values(result.totals).reduce((s, n) => s + n, 0);
                $totals.textContent = formatTroopsTotalsB(result.totals);
                $meta.textContent = `${result.rows.length} vilas · ${totalUnits.toLocaleString('pt-BR')} tropas totais · atualizado às ${nowStrB()} · detalhes em window.TW_BUILD_TROOPS`;
                logB(`Tropas: ${formatTroopsTotalsB(result.totals)} (${result.rows.length} vilas, ${totalUnits} total)`);
                console.log('%c═══ TROPAS POR VILA ═══', 'color:#7a4d1f;font-size:14px;font-weight:bold');
                console.table(result.rows.map(r => ({ vila: r.name, ...r.units })));
                console.log('Totais:', result.totals);
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
            console.log('[TW-BUILD] init() v0.9.0 — URL:', location.href, 'WORLD_MODE:', WORLD_MODE);

            // Em modo br142: sobrescreve templates pra construir SÓ recursos.
            // Sem painel verde — quem comanda é o painel farm laranja via
            // window.TW_BUILD_start/stop/once expostos abaixo.
            if (WORLD_MODE === 'br142') {
                BSTATE.templates.OFF = TEMPLATE_RESOURCES_ONLY;
                BSTATE.templates.NOBLE = TEMPLATE_RESOURCES_ONLY;
                console.log('[TW-BUILD] modo BR142: template = SÓ recursos (wood/stone/iron 1..30).');

                // API global pro painel farm acionar o build loop.
                wB.TW_BUILD_start = () => {
                    if (BSTATE.buildRunning) return false;
                    BSTATE.buildRunning = true;
                    buildLoopB();
                    return true;
                };
                wB.TW_BUILD_stop = () => {
                    BSTATE.buildRunning = false;
                };
                wB.TW_BUILD_once = async () => {
                    const villages = await getAllVillagesB();
                    let done = 0;
                    for (const v of villages) {
                        try { await processVillageBuildB(v); }
                        catch (e) { console.warn('[TW-BUILD] vila', v.name, 'erro:', e.message); }
                        done++;
                        await sleepB(jitterB(BCFG.perVillagePauseMs));
                    }
                    console.log('[TW-BUILD] ciclo único concluído em', done, 'vilas.');
                };
                wB.TW_BUILD_status = () => ({
                    running: BSTATE.buildRunning,
                    cycles: BSTATE.cycleCount,
                    lastCycleAt: BSTATE.lastCycleAt,
                });

                // Aguarda game_data + popula cache de vilas em background.
                const start = Date.now();
                while (Date.now() - start < 8000 && !getGameDataB()) {
                    await sleepB(200);
                }
                const gd = getGameDataB();
                if (gd) {
                    const villages = await getAllVillagesB(true);
                    console.log(`[TW-BUILD] BR142 pronto. World: ${gd.world}, Vilas: ${villages.length}. Use ▶ Build no painel.`);
                }
                return;
            }

            // ===== Modo speed: comportamento original (painel verde grande) =====
            try { injectPanelB(); }
            catch (e) { console.error('[TW-BUILD] painel falhou:', e); return; }

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
