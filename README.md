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

## Instalação no Chrome

1. Instalar **Tampermonkey**: <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>
2. Confirmar que está ativo (ícone na barra)
3. Clicar em **[Install raw script](https://raw.githubusercontent.com/ThCarmo/tribal-wars-userscript/main/src/tw-farm.user.js)**
4. Tampermonkey abre página de confirmação → clicar **Instalar**
5. Abrir o jogo: <https://br142.tribalwars.com.br/>, logar normalmente
6. Painel aparece no canto superior direito da tela

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
