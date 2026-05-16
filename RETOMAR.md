# RETOMAR — Tribal Wars Userscript

> Checkpoint pra próxima sessão. Última atualização: **2026-05-16, fim do dia**.

## Status atual

- **tw-farm.user.js v0.8.1** ✅ Farm BR142 OPERACIONAL desde 14/05 + 🆕 Build/Research/Coin/Snob/Recruit/Ataques em mundo speed brs1.
- Player: **THCARMO**, **100 vilas** em brs1.tribalwars.com.br
- Vila ativa de teste: Aldeia 10 (494|462) — já bateu "template concluído ✓" + heavy:200 + spy:200 confirmado em log

## Arquivo único

`src/tw-farm.user.js` (~135KB). Banner vermelho no topo confirma "v0.8.1 ATIVO". Dois painéis no jogo:
- **Direita (laranja)**: Farm + Tagger (BR142)
- **Esquerda (verde)**: Build/Research/Coin/Snob/Recruit + Atacar Jogador (brs1)

## Sessão de 16/05/2026

Passamos por **18 versões** (v0.4.0 → v0.8.1) numa sessão. Mudanças principais:

### Build + Recruit (v0.4 → v0.5.3)
- Detecção de 100 vilas via fallback `/game.php?screen=overview_villages&mode=combined` (game_data trouxe só 3)
- Fila inteligente: enche os 2 slots por vila por passada (era 1, ele precisava completar manual)
- Skip on pre-req fail: snob falha por falta de smith 5 NÃO trava a vila — pula pro próximo item do template
- Tolerância a erro: vila quebrada loga e segue

### Coin Minter + Snob Trainer (v0.6 → v0.7.5)
- Cunha 1 moeda/vila/passada em todas
- Treina nobre quando tem moedas+pop suficientes
- Roles OFF/NOBLE introduzidos e depois simplificados pra UNIVERSAL (todas vilas iguais)
- Mix tropa: 100% heavy (decisão do user)

### Template estrito (v0.7.6 → v0.7.7)
- Decisão do user: parar de construir prédios desnecessários
- TEMPLATE_UNIVERSAL atual constrói APENAS:
  - main 3→20, recursos 5→25, farm 3→20, storage 3→25
  - barracks 1 (pré-req smith)
  - smith 1→20
  - market 1→10 (pré-req academia)
  - stable 1→10 (pra heavy recrutar)
  - snob 1 (academia, max neste mundo)
- NÃO constrói: garage, hide, wall, watchtower, statue, snob 2/3
- Quando completar: "template concluído ✓" e para de tentar

### Parser conservador (v0.7.8)
- Bug: log `coin: erro` (literal 4 chars). Causa: regex `/error_box|recursos|.../i` casava com QUALQUER página (label "Recursos" no topo) e fallback retornava 'erro'
- Fix: só erro se achar explicitamente `<div class="error_box">`
- Aplicado em 4 funções (mint/snob/recruit/build)
- Cunhagem agora compara coinsBefore vs coinsAfter pra detectar sucesso real

### Contador de Tropas (v0.7.9 + v0.8.1)
- Botão `📊 Tropas` → GET `overview_villages?mode=units` → agregado por unidade
- v0.7.9 buggy: "162 vilas, 0 tropas" (tabela com em casa + em comando + em apoio = 3 linhas por vila + header sem class)
- v0.8.1 fix: agregação multi-linha + fallback PT-BR no header (Lanceiro/Espadachim/Cavalaria pesada/Nobre)
- HTML salvo em `window.TW_BUILD_TROOPS_RAW_HTML` pra debug se ainda falhar
- Display abreviado PT-BR: L (lança), E (espada), M (machado), A (arq), spy, CL (cav leve), AC (arq mont), CP (paladino), AR (ariete), CT (cat), PAL (paladino), NB (nobre)

### Ataques de conquista (v0.8.0)
- Bloco vermelho no painel: `🎯 Conquistar Jogador`
- `fetchPlayerByNameB`: busca em `/map/player.txt`
- `fetchVillagesOfPlayerB`: busca em `/map/village.txt` filtrando por player_id
- `planConquestB`: pra cada vila do alvo (ordenada por pontos asc), escolhe 4 nossas vilas mais próximas com NT+CP disponível. Track de nobres alocados por vila.
- `executeConquestPlanB`: dispara em loop, rate limit 25/min, pausa 2-3s, auto-stop em captcha ou 5 erros sem sucesso
- **2 confirmações obrigatórias** (alert + prompt nome exato) pra evitar Op DST 2.0
- Comp default: 1 NT + 500 CP + 0 spy

## Pendências (próxima sessão)

### Imediato — VALIDAR v0.8.1
1. Atualizar TM pra v0.8.1 (cache GitHub ~5min OU manual via Bloco de Notas)
2. Clicar `📊 Tropas` — esperar: ~100 vilas, totais > 0 (CP, spy, NB)
3. Se ainda 0: F12 console → `TW_BUILD_TROOPS_RAW_HTML.slice(0,3000)` → mandar pro Claude pra calibrar pelo DOM real do brs1

### Próximo — DISPARAR ATAQUES
1. `📋 Planejar Ataque` → digitar "Luis Fuerza" (jogador alvo declarado)
2. Validar plano no alert (X vilas alvo, Y ataques, recursos)
3. Confirmar (digitar nome exato no prompt)
4. Observar log + stop button visível
5. Conferir em `/game.php?screen=overview_villages&mode=commands` que os ataques saíram

### v0.9 (roadmap — discutir antes de codar)
- Ataques SIMULTÂNEOS com chegada coordenada ±1s
- Usa `Timing.getCurrentServerTime()` (nativo do jogo, sem skew)
- Cálculo reverso: "pra chegar às 23:00:00, vila X dispara às 22:25:00"
- Velocidade pela unidade mais lenta da comp (lição Op DST)
- Pre-flight checks rígidos antes de cada salva
- Comp homogênea validada (vila tem NT+CP+escolta exata?)

## Armadilhas registradas (não cair de novo)

1. **`@version` na linha 4 não tem "v"** — Edit replace_all `v0.7.X → v0.7.Y` NÃO pega a linha 4 (`// @version      0.7.X`). Sempre Edit específico pra essa linha.
2. **Cache CDN `raw.githubusercontent.com`** TTL ~5min. Tampermonkey "Verificar atualizações" pode receber versão velha do cache. Workaround: caminho manual (Bloco de Notas → Ctrl+A/C → cola no editor do TM).
3. **Tampermonkey "Acesso ao site = Ao clicar"** em Chrome MV3 silencia tudo. Fix obrigatório: chrome://extensions → TM → Detalhes → "Em todos os sites".
4. **Inputs do painel resetam no F5** — auto-resync mitiga mas se zerado preencher manual antes.
5. **game_data.villages** pode trazer só algumas vilas (3 de 100 no brs1) — fallback `overview_villages?mode=combined` é confiável.
6. **Parser de erro genérico** mata tudo. SEMPRE usar match explícito de `<div class="error_box">...</div>`.
7. **Tabela `overview_villages?mode=units`** tem múltiplas linhas por vila (em casa + em comando + em apoio). Sempre agregar por villageId.

## Como retomar em nova sessão

```bash
cd "C:/Users/Thiago Carmo/projects/tribal-wars-userscript"
git pull
git log --oneline -15
```

Triggers no Claude:
- `retomar tribal` ou `contexto tribal wars` → carrega memória deste projeto

Estado canônico: este README + `git log` + memória em `~/.claude/memory/project_tribal_wars.md`.
