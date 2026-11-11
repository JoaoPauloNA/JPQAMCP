# JPQAMCP — MCP de QA blackbox para Firefox

Teste de QA completo **só pelas telas, como um usuário**: sem ler o código da página.
Roda em Firefox **invisíveis e separados** (perfis temporários, Marionette): não mexe na sua janela, no foco nem no mouse.
Funciona em **macOS, Windows e Linux**, com clientes compatíveis com MCP por stdio.

## Instalar
Requisitos: Node 18+ e Firefox instalado.
```
npm install                     # OCR portátil (tesseract.js); baixa o modelo de português uma vez
./build.sh                      # opcional, só macOS: helper nativo (OCR Vision, mais rápido e mais preciso)
node configurar.mjs             # mostra a configuração MCP com os caminhos certos
```
Copie a configuração gerada para o arquivo de configuração do seu cliente MCP.
O servidor usa o formato `mcpServers`, com `command` apontando para o Node e `args` para `server.mjs`.
Para páginas grandes, configure no cliente um tempo limite de execução de pelo menos 180 segundos.

Se o Firefox não estiver no local padrão, defina `FIREFOX_BIN`.

## Como usar (linguagem natural)
Depois de cadastrar o MCP no seu cliente, basta pedir: *"usando o mcp de QA, teste o projeto http://localhost:3000"* (ou `file://...`). Se a página estiver aberta em alguma aba do Firefox, a sessão dela é usada.

## Ferramentas
- `firefox_qa_completo` — o teste inteiro. Parâmetros: `url`, `aba`, `sessao`, `zoom`, `modo`, `maxTelas`.
- `firefox_qa_aquecer` / `firefox_qa_fechar` — abre/fecha as instâncias invisíveis (a primeira execução gasta ~3 s para abri-las).
- Só macOS com o helper: `firefox_screenshot`, `firefox_click`, `firefox_key` (janela do seu Firefox; clique de mouse não chega ao Firefox em segundo plano).

### O que o teste faz
1. **Acha a aba certa** no seu Firefox (várias janelas e abas) pela URL ou por um trecho do título (`aba`), lendo o arquivo de sessão do perfil. Sem `url`, usa a aba ativa.
2. **Copia a sessão** dessa aba (cookies e storage do site) para os Firefox invisíveis: páginas com login funcionam sem pedir senha. `sessao: "nenhuma"` desliga. Nada é gravado no relatório e os perfis temporários são apagados ao fim. Se a página parecer de login, o relatório avisa.
3. **Mapeia a tela** por OCR e pixels (a página inteira, sem rolar), clica em todos os botões, explora as telas descobertas.
4. **Preenche formulários** (envio vazio, válido, inválido e Limpar), confere máscaras, obrigatórios e validações.
5. **Zoom**: refaz o print das regiões que o OCR leu mal em escala 3x, relê, corrige textos e acha elementos que passaram despercebidos. Roda em paralelo; se atrasar, o teste só espera 1,2 s por ele.
6. Grava `saida/<data>/relatorio.html` com bugs por hora.

## Motores de imagem
| Motor | Onde | OCR |
|---|---|---|
| nativo | macOS (com `./build.sh`) | Vision |
| portátil | Windows, Linux, macOS | tesseract.js |

`FX_BACKEND=js` força o portátil. `FIREFOX_PROFILE` aponta o perfil de onde ler abas e sessão (no macOS o app que roda o MCP precisa poder ler `~/Library/Application Support/Firefox`).

## Tempo (2 telas, 22 campos, 18 botões)
Com o computador livre: ~4–5 s no motor nativo sem zoom e ~10 s no portátil. O zoom soma 1–3 s. Com o computador ocupado, mais. Use `zoom: false` para a execução mais rápida.

## Arquivos
`server.mjs` (MCP) · `qa.mjs` (orquestrador, zoom, sessão) · `sessao.mjs` (abas e cópia de sessão) · `marionette.mjs` (Firefox invisível) · `imagem.mjs` + `imagem-thread.mjs` + `png.mjs` + `analise.mjs` (motor portátil) · `fxctl.swift` (motor nativo) · `report.mjs` · `configurar.mjs` · `exemplos/pagina-de-teste/` (dashboard + cadastro usados nos testes) · `exemplos/teste-login/` (site com login para validar a cópia de sessão).

## Limitações
- Elementos são reconhecidos por OCR e pixels: caixas sem texto e texto muito pequeno ainda podem passar (o zoom reduz isso).
- O teste usa um viewport do tamanho da página inteira: rolagem e elementos fixos não são exercitados.
- Data e hora combinadas, mês e semana ainda não são preenchidos.
- A cópia de sessão não cobre sites que prendem o login à aba ou ao dispositivo.
- Em sistemas reais o teste clica e envia formulários de verdade: prefira ambiente de teste.
- Testado em macOS. Windows e Linux: só o motor portátil, forçado no macOS.

## Evidências e cobertura

Os resultados distinguem **suspeitas** e **inconclusivos**. Uma tela sem mudança após um clique não comprova defeito: o controle pode estar selecionado ou não ter efeito visual previsto. O teste aguarda mais 1,2 s e, para ações sem indicação de envio ou exclusão no rótulo, reabre a página e repete o clique com mais 1,2 s de espera. Essa verificação pode aumentar a duração da execução. Rótulos não garantem que uma ação seja inofensiva; use ambiente de teste.

Cada achado inclui URL, estado inicial, passos, observação, expectativa quando conhecida e imagens. A cobertura mostra cenários executados e não executados, controles ignorados, campos não suportados e URLs descobertas que excederam o limite de telas. Ela descreve apenas o que foi identificado nesta rodada; não comprova cobertura total do projeto.

O `resultado.json` usa `schemaVersion: 2`. O campo `bugs` permanece por compatibilidade, com `status` em cada achado. Caminhos de artefatos são relativos à pasta do relatório; copie a pasta inteira para preservar as evidências. Para gerar novamente o HTML após mover a pasta, carregue o JSON e ajuste `dir` para a pasta atual antes de chamar `relatorioQA`.

Execute `npm test` para verificar cobertura e portabilidade dos relatórios.

### Falhas de acesso ao perfil

Falhas reais de leitura do perfil aparecem como **Erro do MCP**, com código do sistema, no resumo e no HTML. O teste pode continuar sem a sessão, mas não comprova fluxos autenticados. A ausência de uma aba correspondente, por si só, não é tratada como erro de permissão.

No macOS, se houver `EPERM` ou `EACCES`, autorize o aplicativo que inicia o MCP em Ajustes do Sistema → Privacidade e Segurança → Acesso Total ao Disco e reinicie o aplicativo. Essa autorização depende do usuário. `FIREFOX_PROFILE` escolhe uma pasta de perfil existente e acessível; não contorna as permissões do sistema. Um caminho explícito inválido é informado como erro, sem escolher silenciosamente outro perfil.
