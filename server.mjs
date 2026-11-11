#!/usr/bin/env node
// MCP "jpqamcp" (stdio, JSON-RPC por linha). Blackbox: só pixels + eventos enviados ao processo do Firefox.
// Compatível com clientes MCP por stdio.
// O stdout é só do protocolo: qualquer outro texto (inclusive de bibliotecas e threads) vai para o stderr.
const escreverRPC = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
import { execFile } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { relatorioQA } from "./report.mjs";
import { executarQA, aquecer, encerrar, resolverSessao } from "./qa.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FXCTL = join(AQUI, "fxctl");
const SAIDA = join(AQUI, "saida");
mkdirSync(SAIDA, { recursive: true });
// ferramentas da janela do usuário dependem do helper nativo (só macOS)
const JANELA = process.platform === "darwin" && existsSync(FXCTL);

const run = (args, timeout = 180000) =>
  new Promise((resolve, reject) =>
    execFile(FXCTL, args, { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const topo = (a) => String(a?.topoConteudoPt ?? 86);

function listarElementos(d) {
  return d.elementos
    .map((e) => `#${e.id} ${e.kind} "${e.text}" centro(${e.cx},${e.cy}) caixa(x${e.x},y${e.y},${e.w}x${e.h})${e.fixed ? " fixo" : ""}`)
    .join("\n");
}

const TOOLS = [
  {
    name: "firefox_qa_completo",
    description:
      "Teste de QA completo, blackbox (só telas, como usuário): abre a URL num Firefox invisível e separado (não toca na janela do usuário), mapeia a tela por OCR/pixels, clica em todos os botões (cliques reais), descobre e explora as telas seguintes, preenche formulários rapidamente (3 cenários + Limpar), confere máscaras e validações e gera um relatório HTML com bugs por hora. Sem 'url', usa a página aberta no Firefox do usuário (lida da barra de endereço).",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "Endereço a testar. O QA procura a aba que o tem aberto no Firefox do usuário (entre todas as janelas e abas) e copia a sessão dela, então páginas com login funcionam sem pedir senha. Sem 'url', usa a aba ativa." },
      aba: { type: "string", description: "Trecho do título ou da URL para escolher a aba quando houver várias parecidas." },
      sessao: { type: "string", enum: ["auto", "nenhuma"], description: "'auto' (padrão) copia a sessão (cookies e storage do site) da aba encontrada para os Firefox invisíveis; 'nenhuma' testa sem login." },
      modo: { type: "string", enum: ["completo", "rapido"], description: "'rapido' testa um representante de cada botão repetido (padrão: completo)." },
      zoom: { type: "boolean", description: "Refaz o print em zoom 4x das regiões que o OCR leu mal e relê (padrão true; custa ~1 s)." },
      maxTelas: { type: "number", description: "Máximo de telas exploradas (padrão 5)." } } },
  },
  { name: "firefox_qa_aquecer", description: "Abre antecipadamente as instâncias invisíveis para que o teste completo rode sem o tempo de partida (~3 s).", inputSchema: { type: "object", properties: {} } },
  { name: "firefox_qa_fechar", description: "Encerra as instâncias invisíveis do Firefox usadas pelo QA.", inputSchema: { type: "object", properties: {} } },
  {
    name: "firefox_screenshot",
    description:
      "Captura a página inteira do Firefox (rola em segundo plano e costura, sem trazer a janela para frente nem mexer no mouse), desenha uma malha de coordenadas (pontos, a partir do canto superior esquerdo da página) e identifica todos os botões, campos e textos com id e posição. Devolve a imagem limpa (malha opcional) e a lista de elementos com coordenadas para guiar os cliques.",
    inputSchema: { type: "object", properties: { malha: { type: "boolean", description: "Devolver a imagem com a malha e as caixas desenhadas (padrão false: imagem limpa; as coordenadas vêm na lista de elementos)." }, topoConteudoPt: { type: "number", description: "Altura da barra de abas/URL do Firefox em pontos (padrão 86)." } } },
  },
  {
    name: "firefox_click",
    description: "Clica em (x, y) em pontos. space='page' usa coordenadas da página (rola até o ponto); space='window' usa coordenadas da janela. Em segundo plano o Firefox pode ignorar cliques de mouse.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, space: { type: "string", enum: ["page", "window"] } }, required: ["x", "y"] },
  },
  {
    name: "firefox_key",
    description: "Envia uma tecla de navegação ao Firefox em segundo plano: back (Cmd+[), forward (Cmd+]), reload (Cmd+R), tab, enter.",
    inputSchema: { type: "object", properties: { key: { type: "string", enum: ["back", "forward", "reload", "tab", "enter"] } }, required: ["key"] },
  },
];

async function chamar(nome, a = {}) {
  if (nome === "firefox_qa_aquecer") { const ms = await aquecer(); return [{ type: "text", text: ms ? `instâncias prontas em ${ms} ms` : "instâncias já estavam prontas" }]; }
  if (nome === "firefox_qa_fechar") { await encerrar(); return [{ type: "text", text: "instâncias encerradas" }]; }
  if (nome === "firefox_qa_completo") {
    const r = resolverSessao({ url: a.url, aba: a.aba, sessao: a.sessao ?? "auto" });
    let url = r.url;
    if (!url && JANELA) { url = (await run(["url"])).split("#")[0]; }
    if (!url) throw new Error(`não sei qual página testar. ${r.info.aviso || "Abra a página no Firefox ou informe 'url'."}`);
    const res = await executarQA({ url, dirBase: SAIDA, modo: a.modo ?? "completo", maxTelas: a.maxTelas ?? 5, sessao: r.copia, sessaoInfo: r.info, zoom: a.zoom !== false });
    const out = relatorioQA(res);
    const sess = res.sessaoInfo ? (res.sessaoInfo.usada ? `sessão copiada da aba “${res.sessaoInfo.aba.titulo}” (janela ${res.sessaoInfo.aba.janela}, aba ${res.sessaoInfo.aba.aba}; ${res.sessaoInfo.motivo})` : "") : "";
    const linhas = res.telas.map((t, i) => `tela ${i + 1}: ${t.titulo} — ${t.botoes.length} botões clicados, ${t.form ? `${t.form.campos.length} campos, formulário testado` : "sem formulário"}`);
    const bugs = res.bugs.map((b) => `${b.hora} [${b.sev}] ${b.titulo}`);
    return [{ type: "text", text: `Relatório: ${out}\nTempo do teste: ${res.totalMs} ms · motor: ${res.backend}\n${sess}${res.avisos.length ? "\nAVISO: " + res.avisos.join(" ") : ""}\n${linhas.join("\n")}\n\nBugs (${bugs.length}):\n${bugs.join("\n") || "(nenhum)"}` }];
  }
  if (nome === "firefox_screenshot") {
    const dir = join(SAIDA, stamp());
    await run(["shot", dir, topo(a)]);
    const d = JSON.parse(readFileSync(join(dir, "resultado.json"), "utf8"));
    const resumo = `Página ${d.paginaW}x${d.paginaH} pt${d.rolavel ? ` (rolável, ${d.scrollTotalPt} pt)` : ""}; ${d.elementos.length} elementos; captura em ${d.capturaMs} ms; foco do usuário preservado: ${d.focoInalterado}.\nArquivos em ${dir}\n\n${listarElementos(d)}`;
    return [
      { type: "text", text: resumo },
      a.malha
        ? { type: "image", data: readFileSync(join(dir, "pagina_malha.jpg")).toString("base64"), mimeType: "image/jpeg" }
        : { type: "image", data: readFileSync(join(dir, "pagina.png")).toString("base64"), mimeType: "image/png" },
    ];
  }
  if (nome === "firefox_click") {
    await run(["click", String(a.x), String(a.y), a.space === "window" ? "window" : "page"]);
    return [{ type: "text", text: `clique enviado em (${a.x}, ${a.y}) [${a.space ?? "page"}]` }];
  }
  if (nome === "firefox_key") {
    await run(["key", a.key]);
    return [{ type: "text", text: `tecla ${a.key} enviada` }];
  }
  throw new Error(`ferramenta desconhecida: ${nome}`);
}

const send = (o) => escreverRPC(JSON.stringify(o) + "\n");
const VERSOES = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCOES = `JPQAMCP: QA blackbox de páginas web pelo Firefox, só pelas telas (sem ler o código da página).
Use firefox_qa_completo com a url a testar. Ele procura a aba certa no Firefox do usuário (várias janelas/abas), copia a sessão dela para Firefox invisíveis (páginas com login funcionam sem pedir senha), clica em todos os botões, explora as telas descobertas, preenche e valida formulários e grava um relatório HTML com bugs por hora. A resposta já traz o resumo e os bugs em texto. A primeira chamada leva alguns segundos a mais para abrir os Firefox invisíveis (firefox_qa_aquecer antecipa isso). Em sistemas reais o teste clica e envia formulários de verdade: prefira ambiente de teste.`;

// chamadas de ferramenta são serializadas (o pool de Firefox é compartilhado); o resto responde na hora
let serie = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (linha) => {
  if (!linha.trim()) return;
  let m; try { m = JSON.parse(linha); } catch { return; }
  if (m.method === "tools/call") serie = serie.then(() => tratar(m)).catch(() => {});
  else tratar(m).catch(() => {});
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 100));

async function tratar(m) {
  const { id, method, params } = m;
  const ok = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
  try {
    if (method === "initialize") {
      const v = VERSOES.includes(params?.protocolVersion) ? params.protocolVersion : VERSOES[0];
      return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "jpqamcp", title: "JPQAMCP — QA blackbox", version: "0.4.0" }, instructions: INSTRUCOES });
    }
    if (method === "tools/list") return ok({ tools: TOOLS.filter((t) => JANELA || t.name.startsWith("firefox_qa_")) });
    if (method === "tools/call") {
      const t0 = Date.now();
      try {
        const content = await chamar(params.name, params.arguments ?? {});
        return ok({ content });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `erro: ${e.message}` }], isError: true });
      }
    }
    if (method === "ping" || method === "logging/setLevel") return ok({});
    if (method === "prompts/list") return ok({ prompts: [] });
    if (method === "resources/list") return ok({ resources: [] });
    if (method === "resources/templates/list") return ok({ resourceTemplates: [] });
    if (id !== undefined && method && !method.startsWith("notifications/")) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `método não suportado: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}
