# RETOMAR — Tribal Wars Userscript

> Checkpoint pra próxima sessão (Claude ou humano). Última atualização: **2026-05-14, fim da tarde**.

## Status atual: ✅ OPERACIONAL na v0.3.3

Userscript funcionando em produção. Usuário (Dr. Thiago, jogador `ThCarmo`) rodando "Atacar Todos" no mundo BR142, vila 86934 (821|403).

## O que existe e funciona

| Módulo | Status | Botão no painel |
|---|---|---|
| **Farm** via Assistente de Saque (am_farm) | ✅ v0.2.5 | ▶ START / ■ STOP / ⟳ RESYNC |
| **Map Scan** — lê `/map/village.txt`, lista barbáros no raio | ✅ v0.3.0 | 🔍 Buscar Barbs |
| **Praça Sender** — `sendFarmViaPlace(targetId, light, spy, dryRun)` flow 3-step | ✅ v0.3.1 | 🧪 Testar 1 (dry-run) / 🎯 Atacar 1 (REAL) |
| **Atacar Todos** — loop sobre scan com guard-rails | ✅ v0.3.2 | 💥 ATACAR TODOS / ■ PARAR |
| Auto-resync se inputs zerados + razão de parada no log | ✅ v0.3.3 | — |
| **Tagger** — classifica incomings por velocidade | ✅ v0.2.0 | ⟳ Analisar / ■ STOP |

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

1. Abrir `br142.tribalwars.com.br`, logar
2. Tampermonkey deve ter script ativo (atualizar via "Verificar atualizações" se quiser pegar versão nova)
3. Banner vermelho no topo confirma versão ativa
4. Painel canto superior direito tem 3 blocos: Farm, Map Scan, Tagger
5. Fluxo padrão de farm: 🔍 Buscar Barbs → ⟳ resync (Farm) → 💥 ATACAR TODOS

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
