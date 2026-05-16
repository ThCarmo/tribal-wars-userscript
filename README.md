# TW Farm + Tagger — ThCarmo

Userscript privado pro Tribal Wars BR mundo 142. Roda no Chrome via Tampermonkey, dentro da sessão autenticada do jogador. Substitui o bot Python+Playwright anterior (encerrado em 13/05 após Op DST).

## Por que userscript?

- **Skew sysclock vs server desaparece** — usa `Timing.getCurrentServerTime()` nativo do jogo
- **Comp inválida quica antes de sair** — servidor responde direto, sem UI scraping frágil
- **F12 console pra debug em tempo real** — chega de `pythonw.exe` morrer silencioso
- **Sem detecção por IP/headless** — roda na própria sessão do operador

## Módulos

### ⚔ Farm
- Comp **2 light + 1 spy** (template A do Assistente de Saque, precisa estar configurado manual no jogo)
- Raio máximo configurável (padrão 35 campos)
- Priorização **near-first** (alvos mais próximos primeiro)
- Cooldown local (padrão 30min) pra não bater no mesmo barbáro
- Jitter aleatório **3000-7000ms** entre ataques (anti-detecção comportamental) — ajustável no painel em tempo real. Cadência padrão dá ~12 farms/min, indistinguível de humano com hotkey.
- **Guard-rail CL**: para automaticamente quando CL em casa < 2 (maximiza uso de cavalaria leve, spy sobressalente não bloqueia)
- Detecção de Proteção/captcha (para automaticamente)
- Botão RESYNC pra reler estoque de tropa atual

### 🛡 Incoming Tagger
- Botão "Analisar" no painel — fetch lista de incomings, classifica cada um por velocidade min/campo
- Etiquetas:
  - `[SPY?]` velocidade < 9.5 min/c
  - `[CL?]` velocidade 10-11 (light/heavy)
  - `[CP?]` velocidade ~14 (mista)
  - `[OFF?]` velocidade 18-22 (axe/sword/spear)
  - `[NT_OU_ARIETE?]` velocidade ~28-30
  - `[NT?]` velocidade ≥31 (snob é a unidade mais lenta)
- Não roda em polling automático (risco de detecção). Operador clica quando quer.

### 🏗 Build + Recruit (mundo speed) — adicionado em v0.4.0

Integrado **dentro do mesmo userscript** (mesmo `tw-farm.user.js`). Sem segundo script no Tampermonkey. Foco em mundo speed onde farm não compensa e o gargalo é construir + recrutar rápido em todas as vilas.

- **Build Queue** — itera `game_data.villages`, para cada uma lê `screen=main`, identifica próximo prédio do template que ainda não foi atingido (e não está na fila), enfileira via `ajaxaction=upgrade_building`. Loop a cada 90s (ajustável). Multi-vila nativo, sem trocar contexto.
- **Template editável** — array JSON `[["wood", 5], ["main", 3], ...]`. Default vem com 48 entradas otimizadas para off rush em mundo speed. Persiste em localStorage.
- **Recruiter** — para cada vila, GET barracks/stable/garage, parser dos custos de cada unidade, calcula quantas dá pra recrutar com base em mix de pesos + % dos recursos atuais. POST de recrutamento por screen.
- **Mix editável** — objeto JSON `{"axe":0.4,"light":0.3,"spy":0.05}`. Pesos relativos. Default off-balanceado (40% axe, 30% light, 10% spear/heavy, 5% sword/spy).
- **Guard-rails**: respeita slots de fila (2 sem Premium, 5 com), respeita pop livre, cap por unidade por ciclo (200 default).
- **Painel à esquerda** (o de farm fica à direita, não colidem). Lista de vilas + log das 30 últimas ações.

## Instalação no Chrome

1. Instalar **Tampermonkey**: <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>
2. Confirmar que está ativo (ícone na barra)
3. Instalar o script único (Farm + Build + Recruit + Tagger juntos): **[Install raw](https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js)**
4. Tampermonkey abre página de confirmação → clicar **Instalar**
5. **Importante (Chrome MV3)**: chrome://extensions/ → Tampermonkey → Detalhes → "Acesso ao site" = **Em todos os sites** (se ficar em "Ao clicar", o script não injeta automaticamente)
6. Abrir o jogo, logar normalmente
7. Painel de farm aparece à direita (laranja), painel de build aparece à esquerda (verde)

## Uso

### Farm
1. Configurar template **A** do Assistente de Saque (1x manual no jogo): `light=2, spy=1`
2. Abrir a tela **Assistente de Saque** (`screen=am_farm`) na vila que vai farmar
3. Painel mostra estoque de CL/Spy detectado (ajustar manual se ⟳ não detectar)
4. Configurar raio + cooldown se quiser mudar do padrão
5. Clicar **▶ START** — bot começa a disparar farms ordenados por distância
6. Para automático quando: CL esgota, captcha detectado, ou STOP manual

### Tagger
1. Em qualquer tela do jogo
2. Clicar **⟳ Analisar** — bot busca os incomings e etiqueta cada um
3. Voltar pro overview de incomings pra ver as labels aplicadas

### Build (mundo speed)
1. Em **qualquer tela** do jogo (não precisa estar na sede)
2. Conferir no painel verde à esquerda que o número de vilas detectadas bate
3. Rodar **▷ 1 ciclo só (debug)** primeiro — olhar o log das últimas 30 ações. Se aparecer "CSRF não encontrado", "fila cheia", "OK main→4" pra cada vila, está OK.
4. Se OK: **▶ START BUILD** — entra em loop, processa todas as vilas a cada 90s
5. Pra customizar a ordem: **✎ Editar template** abre um prompt com o array JSON atual. Buildings válidos: `main barracks stable garage snob smith place market wood stone iron farm storage hide wall watchtower statue`
6. **■ STOP** para o loop após a vila atual

### Recruit (mundo speed)
1. Pré-requisito: a vila precisa ter quartel/estábulo construído (build cuida disso)
2. **▷ 1 ciclo só (debug)** primeiro — confirma que parser de custos achou as unidades
3. Se OK: **▶ START RECRUIT** — recruta 85% dos recursos disponíveis em cada vila por ciclo, conforme mix configurado
4. **✎ Editar mix tropa** abre prompt com o JSON. Pesos relativos: `{"axe":0.4, "light":0.3, "spy":0.05}` significa 40% recursos para axe, 30% para light, 5% para spy

## Configuração do Tampermonkey pra auto-update

Tampermonkey → Painel → aba **Script** → opção **Atualização**: definir intervalo (24h é padrão). O script consulta `updateURL` do `raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main` e baixa nova versão automaticamente quando há commit.

## Limitações conhecidas (v0.2.0)

- **Single-village**: roda só na vila atual. Multi-village fica pra v0.3.
- **Sem auto-resync de tropa**: contador local decrementa, mas só re-lê do jogo quando o operador aperta ⟳. Em loop longo pode dessincronizar.
- **Inferência do Tagger**: só por velocidade. Não distingue NT-real de NT-fake (mesma velocidade). Pra distinguir precisa cruzar com histórico do jogador atacante (pendência).
- **Auto-fix de template A**: NÃO está implementado. Se Sr. mudou template A pra outra coisa, farm vai disparar comp errada. Confirmar antes de cada sessão.
- **Detecção comportamental**: jitter 800-2500ms ajuda, mas não é proteção 100%. Em sessões longas (>2h) sem pausa real, Proteção pode bater mais cedo.

## Lições aplicadas (Op DST 13/05)

Erros graves do bot anterior, todos eliminados pela arquitetura userscript:

1. **Piso 72 pop** — não vale pra barbáro, mas se algum dia o farm atingir jogador, o `errorMessageInDom()` captura e para o loop.
2. **Velocidade da unidade mais lenta** — não aplicável ao farm (comp homogênea 2L+1S). Crítico no Tagger (inferência inversa).
3. **Skew sysclock vs server** — eliminado, `Timing.getCurrentServerTime()` é nativo.
4. **pythonw silencioso** — substituído por console F12.
5. **UI scraping frágil** — substituído por `.click()` direto no botão A nativo do jogo.

## Roadmap

- v0.3 — multi-village + tagger com polling controlado (a cada 5min, jitter)
- v0.4 — NT/fakes coordinator (refazer o que era a Op DST, mas via userscript)
- v0.5 — auto-recruta (builder) pra acelerar reposição de tropa
