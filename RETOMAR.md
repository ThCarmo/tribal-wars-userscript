# RETOMAR — Tribal Wars Userscript

> Checkpoint pra próxima sessão (Claude ou humano). Última atualização: **2026-05-16**.

## Status atual

- **tw-farm.user.js v0.4.0** ✅ Farm OPERACIONAL (BR142) + 🆕 Build/Recruit RECÉM-INTEGRADO (não testado).
  - Em 2026-05-16: Dr. Thiago entrou em mundo speed novo, pediu construção+recrutamento. Foi criado `tw-build.user.js` como arquivo separado, depois **fundido dentro do tw-farm** a pedido do usuário (não queria gerenciar 2 scripts no Tampermonkey). Build vive num IIFE isolado com sufixo `B`/`B...` em todas as variáveis pra não colidir com farm.

Usuário (Dr. Thiago, jogador `ThCarmo`) opera 2 mundos:
- **BR142**: mundo "normal", usa farm + tagger
- **Mundo speed novo (URL ainda pendente)**: usa build + recruit. Sem necessidade de farm.

## O que existe e funciona

**Arquivo único agora**: `src/tw-farm.user.js` (v0.4.0). 2 painéis num só userscript: Farm (laranja, direita) + Build (verde, esquerda).

### Painel Farm (direita, laranja) — funciona em BR142

| Módulo | Status | Botão |
|---|---|---|
| **Farm** via Assistente de Saque (am_farm) | ✅ v0.2.5 | ▶ START / ■ STOP / ⟳ RESYNC |
| **Map Scan** — lê `/map/village.txt`, lista barbáros no raio | ✅ v0.3.0 | 🔍 Buscar Barbs |
| **Praça Sender** — `sendFarmViaPlace(targetId, light, spy, dryRun)` flow 3-step | ✅ v0.3.1 | 🧪 Testar 1 / 🎯 Atacar 1 (REAL) |
| **Atacar Todos** — loop sobre scan com guard-rails | ✅ v0.3.2 | 💥 ATACAR TODOS / ■ PARAR |
| Auto-resync se inputs zerados + razão de parada no log | ✅ v0.3.3 | — |
| **Tagger** — classifica incomings por velocidade | ✅ v0.2.0 | ⟳ Analisar / ■ STOP |

### Painel Build (esquerda, verde) — 🆕 v0.4.0, focado em mundo speed

| Módulo | Status | Botão |
|---|---|---|
| **Build Queue** — itera todas as vilas, lê sede, enfileira próximo prédio do template | 🆕 v0.4.0 | ▶ START BUILD / ■ STOP / ▷ 1 ciclo |
| **Template editável** — JSON `[["wood", 5], ["main", 3], ...]`, persiste em localStorage chave `twBuildTemplate` | 🆕 v0.4.0 | ✎ Editar template |
| **Recruiter** — itera vilas, GET barracks/stable/garage, POST recrutamento por mix | 🆕 v0.4.0 | ▶ START RECRUIT / ■ STOP / ▷ 1 ciclo |
| **Mix editável** — JSON `{"axe":0.4,"light":0.3}`, peso relativo, persiste em `twBuildTroopMix` | 🆕 v0.4.0 | ✎ Editar mix tropa |
| **Multi-vila nativo** — usa `game_data.villages` direto, sem trocar contexto do jogo | 🆕 v0.4.0 | — |
| **Painel à esquerda** com lista de vilas + log das 30 últimas ações | 🆕 v0.4.0 | — |

**Arquitetura do build dentro do farm**: tudo num IIFE `buildRecruitModule()` no fim do `mainWorldScript`. Variáveis sufixadas com `B` ou nomes próprios (`BCFG`, `BSTATE`, `logB`, `sleepB`, `jitterB`, `injectPanelB`, `initB`) pra zero colisão com farm. Pode ler isso de cima a baixo sem confundir com o farm.

**Defaults out-of-the-box:**
- Ciclo: 90s (mundo speed). Para mundo normal subir pra 600s.
- Slots fila: 2 (sem Premium). Quem tem Premium: subir pra 5.
- Recruit %: 85% dos recursos disponíveis por ciclo, cap 200/unidade.
- Mix: 40% axe + 30% light + 10% spear + 10% heavy + 5% sword + 5% spy (off com defesa mínima).
- Template build: 48 entradas, "off rush" — main 3 → recursos 5 → barracks/smith → recursos 8 → barracks/main 10 → stable → ... → muralha → garage → snob.

**Pendências esperadas no 1º shake-down:**
- Parser de nível (`parseCurrentLevels`) pode falhar se DOM do mundo speed for diferente do BR142 — verificar console F12.
- Endpoint `ajaxaction=upgrade_building` pode ter response diferente — checar `enqueueBuild` rejeitando válidos como ambíguos.
- Recrutamento parser de custos (`parseUnitCosts`) usa `data-costs` em JSON; se mundo não expõe, cai no fallback `.cost_wood` etc — pode falhar e logar "sem custos parseáveis".
- Se falhar: o ciclo "1 ciclo só (debug)" não bloqueia, mostra no log o que deu — usar pra calibrar antes de deixar loopando.

## Configuração padrão atual

- **Comp**: 2 light + 1 spy (template A do Loot Assistant — configurado manual no jogo)
- **Raio**: 35 campos (configurável no painel)
- **Cooldown por alvo**: 30min (persistido em `localStorage` key `twFarmLastFarmByTarget`, compartilhado entre Farm e Map Scan)
- **Jitter**: 3000-7000ms entre farms
- **Guard-rails**: CL<2, spy<1, captcha, 5 erros sem 1 sucesso → para automaticamente

## Validações no mundo real (14/05/2026)

- Vila origem 86934 (821|403): **412 barbáros no raio 35** (vs 17 do Loot Assistant — 24x cobertura)
- Estoque inicial: 708 CL + 470 spy → máx **353 ataques** possíveis na sessão (limitado por CL/2)
- Ataque manual em 90857 (820|405, 2.2c): confirmado em "Comandos" do jogo
- Atacar Todos: iniciado e funcionando ao final da sessão

## Pendências claras / próximos passos

### v0.3.4 — Multi-vila (alta prioridade)
Hoje o bot ataca SÓ da vila ativa no jogo (`game_data.village.id`). Pra o Sr. ter farm de TODAS as vilas dele:
- Iterar `game_data.player.villages` (objeto com todas as vilas do jogador)
- Pra cada uma: trocar contexto (`/game.php?village=ID&screen=overview` GET pra "ativar") e rodar scan + atacar
- OU: passar `village` parameter direto pra `sendFarmViaPlace` em vez de ler do `game_data`

### v0.3.5 — Persistência de contadores
Hoje `STATE.sent`, `STATE.errors` zeram no F5. Salvar em `localStorage` chave `twFarmSession` com timestamp do início — restaurar se F5 dentro de 12h.

### v0.4 — Refazer Op DST
Operação coordenada de NT+fakes que falhou em 13/05/2026 (falha tática, não anti-bot). Pre-flight checks rígidos: skew sysclock vs server, piso 72 pop, velocidade da unidade mais lenta, comp valida antes de sair.

### Limitações conhecidas

- **Auto-fix de Template A não implementado**: se Sr. mudou template A pra outra coisa, farm via am_farm dispara comp errada. Confirmar antes de cada sessão.
- **Tagger**: só distingue por velocidade min/c, não cruza com histórico do atacante (NT-real vs NT-fake têm mesma velocidade).
- **village.txt cache**: o endpoint é regenerado a cada poucos minutos pelo servidor; ataque em vila que mudou de dono no meio do scan vira "erro" (não para o loop, só conta).

## Como retomar em uma nova sessão

```bash
cd "C:/Users/Thiago Carmo/projects/tribal-wars-userscript"
git pull
git log --oneline -10   # ver últimos commits
```

Repo: https://github.com/ThCarmo/tribal-wars-userscript (público)

### Para o usuário (Dr. Thiago, jogo)

**Farm (BR142):**
1. Abrir `br142.tribalwars.com.br`, logar
2. Tampermonkey deve ter `tw-farm` ativo (atualizar via "Verificar atualizações" se quiser pegar versão nova)
3. Banner vermelho no topo confirma versão ativa
4. Painel canto superior direito tem 3 blocos: Farm, Map Scan, Tagger
5. Fluxo padrão de farm: 🔍 Buscar Barbs → ⟳ resync (Farm) → 💥 ATACAR TODOS

**Build + Recruit (mundo speed novo):**
1. Já está dentro do `tw-farm.user.js` v0.4.0 — não precisa instalar segundo script. Basta atualizar o script existente no Tampermonkey (Verificar atualizações, OU copiar+colar conteúdo do raw).
2. Abrir o servidor do mundo speed, logar
3. Banner vermelho do farm agora diz "v0.4.0 — painéis: Farm à direita, Build à esquerda"
4. Painel verde aparece à ESQUERDA com seções Build Queue + Recruit + lista de vilas + log
5. **Antes de soltar**: rodar 1× "▷ 1 ciclo só (debug)" do Build e do Recruit — olhar log no painel ou F12 console pra ver se prédios + custos estão sendo parseados certo
6. Se OK: clicar ▶ START BUILD e ▶ START RECRUIT — vai rodar até clicar ■ STOP
7. Pra customizar: ✎ Editar template (lista de prédios) e ✎ Editar mix tropa

### Para o agente que pegar essa sessão

- Stack: vanilla JS, sem build, distribui via raw GitHub
- `src/tw-farm.user.js` é o arquivo único (~700 linhas)
- Tampermonkey roda em "main world" via `script-tag bridge` (manifest V3 ignora `@inject-into page`)
- `game_data` é a fonte canônica pra vila origem, jogador, csrf
- Endpoint público do TW: `/map/village.txt` (CSV `id,name,x,y,player_id,points,rank`)
- Ataque via Praça: `screen=place` POST com 3 etapas (form fetch → try=confirm → action=command)

## Armadilhas registradas (não cair de novo)

1. **Tampermonkey "Ao clicar" em Chrome MV3 silencia tudo** — `chrome://extensions/` → TM → Detalhes → "Em todos os sites". (Detalhado em `~/.claude/memory/feedback_tampermonkey_chrome_mv3.md`)
2. **BR142 não traz coordenadas no link `info_village`** — parser precisa varrer cada `<td>` da row, não confiar no link. (Fix em v0.2.5)
3. **Inputs do painel resetam no F5** — auto-resync mitiga (v0.3.3), mas se ainda zerado, preencher manual antes de Atacar Todos.
4. **`bot Python anterior` em `~/projects/tribal-wars-bot`**: também existe, mas userscript foi escolhido como caminho principal (sem skew de relógio, sem pythonw silencioso, sem UI scraping frágil).

## Triggers de comando no Claude

- `retomar tribal` ou `contexto tribal wars` → carrega memória deste projeto
- Memória em `~/.claude/memory/project_tribal_wars.md` (auto-loaded via MEMORY.md)
