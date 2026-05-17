# RETOMAR — Tribal Wars Userscript

> Checkpoint pra próxima sessão. Última atualização: **2026-05-17, sessão v0.9.0**.

## Status atual

- **tw-farm.user.js v0.9.0** ✅ Refator grande — **modo BR142** ativo (mundo speed `brs1` encerrado).
- Painel unificado **arrastável** (header com cursor:move, salva posição em localStorage) + botão minimizar.
- Farm em conformidade com nova regra do mundo: **21 CL + 1 Spy** (≥81 pop).
- Priorização de alvos via **Loot Assistant nativo** (🟢 cheias → 🟡 parciais → ⚪ desconhecidas; 🔴 vazias puladas).
- Build SÓ recursos (wood/stone/iron 1→30, intercalado por nível). Sem warehouse/farm/smith — sobe quando há recursos.
- Todos os módulos brs1 (recruit/research/coin/snob/ataques) PRESERVADOS no código mas DESATIVADOS via guard `WORLD_MODE !== 'speed'`. Pra reativar: trocar 1 linha `const WORLD_MODE = 'br142'` no topo.

## Arquivo único

`src/tw-farm.user.js`. Banner vermelho confirma "v0.9.0 ATIVO — modo: BR142".

- **Painel laranja (direita por default, mas arrastável)**: Farm + Map Scan + Build Recursos + Tagger
- **Painel verde (esquerda)**: NÃO injetado em modo br142

## Mudanças v0.9.0 (em ordem)

### 1. WORLD_MODE no topo
```js
const WORLD_MODE = 'br142';  // 'br142' | 'speed'
```
- `br142`: farm 21CL+1Spy via LA, build só recursos. Painel verde NÃO aparece, loops recruit/research/coin/snob/attack retornam cedo.
- `speed`: tudo como na v0.8.1 (preservado integralmente).

### 2. CFG.attackUnits configurável no painel
- Default `{light: 21, spy: 1}` (mínimo 81 pop em BR142).
- Inputs editáveis no painel: "Pacote: __ CL + __ Spy".
- Aplicado em todas chamadas: `farmLoop`, `mapScanFarmAll`, dry-run, real-1, confirm dialog.

### 3. fetchLootAssistantStatus()
- GET `/game.php?screen=am_farm&order=distance&dir=asc&Farm_page=0&Farm_per_page=1000`
- Detecta por regex em `tr.innerHTML`: dots/green|yellow|red|grey + classes `report_y_yes/no/partial` + `status_green/yellow/red`
- Retorna `{ villageId: 'full'|'partial'|'empty'|'unknown' }`
- Caller (`mapScanFarmAll`) re-ordena por status então distância. Vazias são puladas.

### 4. Painel unificado arrastável
- Wrapper `position:fixed` com top/left vindos de `localStorage['twFarmPanelPos']`.
- Header `cursor:move` + mousedown/move/up handlers no document (continua trackeando se cursor sair).
- Botão minimizar (➖/➕) salva estado em `localStorage['twFarmPanelCollapsed']`.
- Em br142: adiciona seção "🏗 Build Recursos" com botões Start/Stop/1×.

### 5. TEMPLATE_RESOURCES_ONLY
```js
const TEMPLATE_RESOURCES_ONLY = (() => {
    const tpl = [];
    for (let lvl = 1; lvl <= 30; lvl++) {
        tpl.push(['wood', lvl]);
        tpl.push(['stone', lvl]);
        tpl.push(['iron', lvl]);
    }
    return tpl;
})();
```
- 90 entradas, intercalado por nível (wood1, stone1, iron1, wood2, stone2, iron2, ...).
- Distribui produção uniformemente em vez de zerar um recurso só.
- buildLoopB só constrói quando há recursos → sem armazém no template, só sobe conforme acumula.

### 6. API global cross-IIFE
Em modo br142, o IIFE B expõe:
- `window.TW_BUILD_start()` → inicia buildLoopB. Retorna true se iniciou, false se já rodava.
- `window.TW_BUILD_stop()` → para o loop.
- `window.TW_BUILD_once()` → roda 1 ciclo manual em todas as vilas.
- `window.TW_BUILD_status()` → `{ running, cycles, lastCycleAt }`.

Painel farm faz poll a cada 3s pra atualizar status.

## Pendências (próxima sessão)

### Imediato — VALIDAR v0.9.0 em produção

1. Atualizar Tampermonkey pra v0.9.0 (cache GitHub ~5min OU manual via Bloco de Notas)
2. Abrir vila BR142. Banner deve dizer "v0.9.0 ATIVO — modo: BR142".
3. **Drag**: arrastar painel pelo header. Recarregar página — deve voltar na posição salva.
4. **Minimizar**: clicar ➖, conteúdo some, ícone vira ➕. F5 — estado preservado.
5. **Pacote**: campo "Pacote: 21CL + 1Spy". Editável.
6. **Farm via LA**:
   - Clicar 🔍 Buscar Barbs (raio configurável).
   - Clicar 💥 ATACAR TODOS. Confirm deve mostrar "Pacote: 21CL+1Spy (≥81 pop)" e "Prioridade: 🟢 cheias → 🟡 parciais → ⚪ desconhecidas".
   - Log deve aparecer "LA status: 🟢 X cheias · 🟡 Y parciais · ⚪ Z desconhecidas · 🔴 W vazias".
   - Cada envio loga com ícone correspondente.
7. **Build Recursos**:
   - Seção "🏗 Build Recursos" deve aparecer (só em br142).
   - Clicar ▶ Build. Status muda pra "rodando".
   - Log do build aparece no console (F12). Não há painel verde com log visual.
   - Verificar via overview do jogo se filas de construção começaram a aparecer com wood/stone/iron.

### Se der problema com Loot Assistant
- Pode acontecer dos seletores não baterem (HTML do LA varia entre mundos/versões).
- Sintoma: "LA status: 🟢 0 · 🟡 0 · ⚪ N · 🔴 0" (tudo unknown) ou erro `tabela não encontrada`.
- Fix: F12 → ir em `/game.php?screen=am_farm` → Inspecionar 1 linha da tabela → mandar HTML pro Claude calibrar seletor.

### Se travar build (sem armazém)
- Esperado em algum momento: wood 25+ exige >94k armazém. Build vai falhar com "sem recursos" perpetuamente.
- Decisão na hora: **liberar warehouse** no template? Ou cap em wood/stone/iron 24?
- Mudança simples: adicionar `['storage', 25]` em posição estratégica do TEMPLATE_RESOURCES_ONLY.

### Roadmap (futuro)
- **Voltar pra brs1 ou novo mundo speed**: trocar `WORLD_MODE = 'speed'` → tudo volta (build/recruit/research/coin/snob/ataques).
- **v0.9.1**: ajustar template de recursos se precisar warehouse ou cap diferente.
- **v0.9.2** (BR142 maduro): adicionar tagger de relatórios + auto-detecção de saque máximo retornado pra calibrar pacote.
- **v1.0 (futuro mundo speed)**: ataques SIMULTÂNEOS coordenados (chegada ±1s) — backlog do brs1.

## Armadilhas registradas

1. **`@version` na linha 4 não tem "v"** — Edit replace_all `v0.X.Y → v0.Z.W` NÃO pega `// @version      0.X.Y`. Edit específico pra essa linha.
2. **Cache CDN `raw.githubusercontent.com`** TTL ~5min. Workaround: cola manual pelo Bloco de Notas.
3. **Tampermonkey "Acesso ao site = Ao clicar"** em Chrome MV3 silencia tudo. Fix: chrome://extensions → TM → Detalhes → "Em todos os sites".
4. **Inputs do painel resetam no F5** — auto-resync mitiga. Pacote default vem do CFG (21/1) — usuário pode editar.
5. **game_data.villages** pode trazer só algumas vilas — fallback `overview_villages?mode=combined`.
6. **Parser de erro genérico** mata tudo. SEMPRE match explícito de `<div class="error_box">`.
7. **NOVO v0.9**: cross-IIFE — painel farm e buildRecruitModule são closures separados. Comunicação via `window.TW_BUILD_*`. Se startar build mas API não existir ainda, mostra alert "ainda inicializando".

## Como retomar em nova sessão

```bash
cd "C:/Users/Thiago Carmo/projects/tribal-wars-userscript"
git pull
git log --oneline -15
```

Triggers no Claude:
- `retomar tribal` ou `contexto tribal wars` → carrega memória deste projeto

Estado canônico: este README + `git log` + memória em `~/.claude/memory/project_tribal_wars.md`.
