// Orquestrador do QA completo (blackbox): só telas, como usuário. Pool de Firefox invisíveis (Marionette) + backend de imagem.
import { writeFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abrirInstancia, fecharInstancia, KEY } from "./marionette.mjs";
import * as img from "./imagem.mjs";
import { perfilAtivo, abasAbertas, localizarAba, resumo } from "./sessao.mjs";

import { portatil, cobertura } from "./evidencias.mjs";

const hora = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (u) => String(u).split("#")[0];

// ---------------- pool ----------------
let pool = null, poolChave = "", lupa = null, lupaFila = Promise.resolve();
export async function aquecer(n = 4, sessao = null, comLupa = false) {
  const chave = sessao ? `${sessao.perfilOrigem}|${sessao.url && new URL(sessao.url).origin}` : "";
  if (pool && chave === poolChave) { if (comLupa && !lupa) { const t = Date.now(); lupa = await abrirInstancia({ id: 9, dpr: ZOOM, sessao }).catch(() => null); if (lupa && sessao?.url && lupa.copiaSessao?.sessao?.length) { try { await lupa.ir(new URL(sessao.url).origin + "/"); await lupa.injetarCookies(lupa.copiaSessao.sessao); } catch {} } return Date.now() - t; } return 0; }
  if (pool) await encerrar();                       // outra sessão: recomeça com perfis novos
  const t = Date.now();
  // a "lupa" é uma instância extra com escala 4x, usada só para refazer o print de regiões difíceis de ler
  const [abertas, lup] = await Promise.all([Promise.allSettled(Array.from({ length: n }, (_, i) => abrirInstancia({ id: i, sessao }))),
    comLupa ? abrirInstancia({ id: 9, dpr: ZOOM, sessao }).catch(() => null) : null, img.prepararBackend()]);
  const ok = abertas.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length) throw abertas[0].reason;
  lupa = lup;
  // cookies de sessão (sem validade) entram com a aba já no domínio
  if (sessao && ok[0].copiaSessao?.sessao?.length) {
    await Promise.all([...ok, lupa].filter(Boolean).map(async (w) => { try { await w.ir(new URL(sessao.url).origin + "/"); await w.injetarCookies(w.copiaSessao.sessao); } catch {} }));
  }
  pool = ok; poolChave = chave;
  return Date.now() - t;
}
export async function encerrar() { pool?.forEach(fecharInstancia); fecharInstancia(lupa); pool = null; lupa = null; poolChave = ""; await img.encerrarBackend(); }

// ---------------- imagens: grava, gera miniatura e roda OCR em segundo plano, já durante os testes ----------------
const OCR = new Map();                 // caminho do png -> segmentos de texto
const MINI = new Map();                // caminho do png -> miniatura para o relatório
const PEND = [];                       // tudo que ainda está rodando
function registrar(tela, nome, b64, { ocr = false, largura = 560 } = {}) {
  const dir = join(tela.dir, "img"); mkdirSync(dir, { recursive: true });
  const png = join(dir, nome + ".png");
  const p = writeFile(png, Buffer.from(b64, "base64")).then(() => Promise.all([
    img.miniatura(png, largura).then((m) => MINI.set(png, m)),
    ocr ? img.ocr(png).then((segs) => OCR.set(png, segs)) : null,
  ]));
  PEND.push(p.catch(() => {}));
  return png;
}

// ---------------- tela ----------------
async function prepararTela(w, url, altura) {
  await w.mover(2, 2);                          // ponteiro neutro: evita hover herdado de tarefas anteriores
  if (altura) { await w.ir(url); await w.tamanho(1280, altura); return { ih: altura, sh: altura }; }
  await w.ir(url);
  await w.tamanho(1280, 1040);
  let [, ih, sh] = await w.medidas();
  const delta = 1040 - ih;
  for (let i = 0; i < 2; i++) {
    await w.tamanho(1280, Math.max(1040, sh + delta));
    [, ih, sh] = await w.medidas();
    if (sh <= ih) break;
  }
  return { ih, sh };
}

async function mapear(w, url, dir) {
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const medida = await prepararTela(w, url);
  const base = await w.print(false);
  writeFileSync(join(dir, "pagina.png"), Buffer.from(base, "base64"));
  const pagina = join(dir, "pagina.png");
  const d = await img.analisar(pagina, dir);
  PEND.push(img.miniatura(pagina, 900).then((m) => MINI.set(pagina, m)).catch(() => {}));
  const est = await w.estado();
  const alturaExterna = (await w.cmd("WebDriver:GetWindowRect")).height;
  return { url: est[0], alturaExterna, titulo: await w.titulo(), dir, pagina: { w: d.paginaW, h: d.paginaH }, elementos: d.elementos, base, hora: hora(), mapearMs: Date.now() - t0, botoes: [], form: null, campos: [] };
}


// ---------------- zoom: refaz o print em escala 4x só das regiões duvidosas e lê de novo ----------------
const ESPERA_ZOOM = 1200;                // quanto o teste espera pelo zoom depois que todo o resto terminou (ms)
const ALT_BANDA = 420;                   // altura (css) de cada foto da lupa
const ZOOM = 3;                          // escala da lupa (a normal é 2)
const SIMBOLO = /^[^\p{L}\p{N}]+$/u;
function candidatosZoom(t) {
  const c = t.elementos.filter((e) => (e.conf < 0.5 || (e.text.length <= 2 && ["texto", "etiqueta", "botao"].includes(e.kind))) && e.w < 400 && e.h < 120);
  return c.sort((a, b) => (a.text.length <= 2 ? 0 : 1) - (b.text.length <= 2 ? 0 : 1) || a.conf - b.conf).slice(0, 14);   // curtos (paginação, ícones) primeiro
}
async function refinarComZoom(t, url, ctl = { cancelado: false }) {
  const cands = candidatosZoom(t); t.zoom = { candidatos: cands.length, regioes: 0, ms: 0, corrigidos: [], novos: [] };
  if (!cands.length || !lupa) { if (cands.length) t.zoom.erro = "lupa indisponível"; return; }
  const t0 = Date.now();
  const fazer = async () => {
    const w = lupa;
    await w.ir(url);
    if (!w.deltaJanela) { await w.tamanho(1280, 900); const [, ih] = await w.medidas(); w.deltaJanela = 900 - ih; }
    await w.tamanho(1280, ALT_BANDA + w.deltaJanela);             // uma janela só: as faixas são obtidas rolando, sem redimensionar
    const faixas = [];
    for (const c of [...cands].sort((a, b) => a.y - b.y)) { const f = faixas[faixas.length - 1]; if (f && c.y + c.h - f.y0 <= ALT_BANDA - 140) f.y1 = Math.max(f.y1, c.y + c.h); else faixas.push({ y0: c.y, y1: c.y + c.h }); }
    const fotos = [];
    for (const [i, f] of faixas.slice(0, 3).entries()) {
      if (ctl.cancelado) { t.zoom.parcial = true; break; }
      const sy = await w.rolarPara(Math.max(0, f.y0 - 110)); await esperar(40);
      fotos.push({ sy, png: registrar(t, `zoom${i + 1}`, await w.print(false), { largura: 700 }) }); t.zoom.regioes++;
    }
    const k = 2 / ZOOM;   // o OCR devolve px/2; em css (escala ZOOM) = saída*2/ZOOM
    const leituras = await Promise.all(fotos.map(async ({ sy, png }) => (await img.ocr(png)).filter((s) => !(sy > 0 && s.y * k < 80)).map((s) => ({ text: s.text, x: s.x * k, y: s.y * k + sy, w: s.w * k, h: s.h * k }))));   // topo da imagem = cabeçalho fixo
    return leituras.flat();
  };
  const lidos = await (lupaFila = lupaFila.then(fazer, fazer));
  if (!lidos) return;
  const cx = (e) => e.x + e.w / 2, cy = (e) => e.y + e.h / 2;
  const dentro = (s, e, m = 4) => cx(s) >= e.x - m && cx(s) <= e.x + e.w + m && cy(s) >= e.y - m && cy(s) <= e.y + e.h + m;
  const usados = new Set();
  for (const e of cands) {
    const s = lidos.filter((l) => dentro(l, e)).sort((a, b) => Math.abs(cx(a) - cx(e)) - Math.abs(cx(b) - cx(e)))[0];
    if (!s) continue; usados.add(s);
    if (s.text !== e.text && !SIMBOLO.test(s.text) && (e.text.length <= 2 ? /[\p{L}\p{N}]/u.test(s.text) && s.text.length <= 4 : semelhanca(s.text, e.text) >= 0.5 && s.text.length <= e.text.length * 1.6 + 2)) { t.zoom.corrigidos.push({ id: e.id, de: e.text, para: s.text, x: e.x, y: e.y }); e.textoOriginal = e.text; e.text = s.text; e.zoom = true; }
  }
  // textos que só apareceram com o zoom; curtos e alinhados a um botão da mesma linha são botões irmãos (paginação, abas)
  let prox = Math.max(0, ...t.elementos.map((e) => e.id)) + 1;
  const irmaos = t.elementos.filter((e) => e.kind === "botao" || e.kind === "etiqueta");
  for (const l of lidos) {
    if (usados.has(l) || SIMBOLO.test(l.text) || l.text.length > 3) continue;
    if (t.elementos.some((e) => dentro(l, e, 6))) continue;
    const irmao = irmaos.find((b) => Math.abs(cy(b) - cy(l)) <= 8 && Math.abs(cx(b) - cx(l)) <= 160);
    if (!irmao) continue;
    const w = Math.max(irmao.w, Math.round(l.w + 16)), h = irmao.h;
    const novo = { id: prox++, kind: "botao", text: l.text, x: Math.round(cx(l) - w / 2), y: Math.round(cy(l) - h / 2), w, h, cx: Math.round(cx(l)), cy: Math.round(cy(l)), fixed: false, hover: false, conf: 0.5, rotulo: "", tipo: "", obrigatorio: false, zoom: true, inferido: true };
    t.elementos.push(novo); t.zoom.novos.push({ id: novo.id, text: l.text, x: novo.x, y: novo.y });
  }
  t.zoom.ms = Date.now() - t0;
}

// ---------------- botões ----------------
async function estavel(w, espera = 60) {   // dois prints iguais seguidos = tela assentada
  await esperar(espera);
  let a = await w.print(false);
  for (let i = 0; i < 4; i++) { await esperar(35); const b = await w.print(false); if (a === b) return a; a = b; }
  return a;
}
async function restaurado(w, base) {       // depois de voltar/recarregar: compara com o estado inicial (tolera repintura tardia)
  for (let i = 0; i < 4; i++) { await esperar(45 * (i + 1)); const re = await w.print(false); if (re === base) return { ok: true, re }; if (i === 3) return { ok: false, re }; }
}

async function testarBotoes(w, tela, alvos, novaTela) {
  await prepararTela(w, tela.url, tela.alturaExterna);
  let base = await estavel(w, 100);
  const urlOrig = tela.url;
  for (const e of alvos) {
    const t0 = Date.now(); const h0 = hora();
    await w.clicar(e.cx, e.cy);
    await w.mover(2, 2);                         // tira o hover: sobra só o efeito real do clique
    await esperar(45);
    let est = await w.estado();
    for (let i = 0; i < 12 && norm(est[0]) !== norm(urlOrig) && est[1] !== "complete"; i++) { await esperar(30); est = await w.estado(); }
    let depois = await w.print(false);
    const tentativas = [];
    const idx = tela.botoes.length + 1;
    // Espera adicional antes de repetir: ações lentas não são classificadas cedo demais.
    if (est[0] === urlOrig && depois === base) {
      await esperar(1200); est = await w.estado(); depois = await w.print(false);
      tentativas.push({ esperaMs: 1200, arqAntes: registrar(tela, `b${idx}_${e.id}_t1_antes`, base), arqDepois: registrar(tela, `b${idx}_${e.id}_t1_depois`, depois) });
      // Envios e ações destrutivas não são repetidos automaticamente.
      if (est[0] === urlOrig && depois === base && !/enviar|salvar|confirmar|comprar|pagar|excluir|deletar|remover|finalizar/i.test(e.text)) {
        await prepararTela(w, tela.url, tela.alturaExterna);
        base = await estavel(w, 100);
        await w.clicar(e.cx, e.cy); await w.mover(2, 2); await esperar(1200);
        est = await w.estado(); depois = await w.print(false);
        tentativas.push({ esperaMs: 1200, arqAntes: registrar(tela, `b${idx}_${e.id}_t2_antes`, base), arqDepois: registrar(tela, `b${idx}_${e.id}_t2_depois`, depois) });
      }
    }
    const navegou = est[0] !== urlOrig;
    const real = navegou || depois !== base;
    const reagirMs = Date.now() - t0;
    const passo = { elemento: e, hora: h0, navegou, urlDepois: est[0], real, reagirMs, tentativas, restaurou: true };
    if (navegou) { passo.tituloDepois = await w.titulo(); novaTela?.(est[0]); }
    passo.arqAntes = registrar(tela, `b${idx}_${e.id}_antes`, base);
    passo.arqDepois = registrar(tela, `b${idx}_${e.id}_depois`, depois, { ocr: true });
    const r0 = Date.now();
    if (navegou) await w.voltar(); else if (real) await w.recarregar();
    if (real) { const r = await restaurado(w, base); if (!r.ok) { passo.restaurou = false; base = r.re; } }
    passo.restauroMs = Date.now() - r0; passo.cicloMs = Date.now() - t0;
    tela.botoes.push(passo);
  }
}

// ---------------- formulário / campos ----------------
const AMOSTRA = {
  email: ["teste.qa@exemplo.com", "teste.qa@exemplo.com", "abc"], telefone: ["11912345678", "(11) 91234-5678", "123"],
  cpf: ["52998224725", "529.982.247-25", "11111111111"], cep: ["01310100", "01310-100", "123"], dinheiro: ["150000", "R$ 1.500,00", null],
  senha: ["Senha1234", "•", "123"], data: ["20051990", "20/05/1990", null], hora: ["1430", "14:30", null], numero: ["12", "12", null],
  url: ["https://exemplo.com", "https://exemplo.com", "abc"], usuario: ["maria_silva", "maria_silva", "A!"], busca: ["teste", "teste", null],
  textolongo: ["Texto de teste automatizado", "Texto de teste", null], nome: ["Maria da Silva", "Maria da Silva", "a"], texto: ["Teste QA", "Teste QA", null],
};
const ordem = (a, b) => a.y - b.y || a.x - b.x;
const SUBMIT = /enviar|cadastrar|salvar|criar conta|registrar|confirmar|entrar|finalizar/i;
const LIMPAR = /limpar|reset/i;

function passosPreencher(campos, marcaveis, modo) {   // modo: "valido" | "invalido"
  const p = []; const nao = [];
  let ult = null, prev = null;     // ult: último controle ("texto" | "select"); prev: último campo de texto
  for (const c of [...campos].sort(ordem)) {
    if (modo === "invalido") {
      const a = AMOSTRA[c.tipo]; if (!a || a[2] == null) continue;
      p.push({ c: [c.cx, c.cy] }, { meta: "a" }, { t: a[2] });
    } else if (AMOSTRA[c.tipo]) { p.push({ c: [c.cx, c.cy] }, { meta: "a" }, { t: AMOSTRA[c.tipo][0] }); ult = "texto"; prev = c; }
    else if (c.tipo === "selecao") {   // clicar abre um popup que engole teclas: foca por Tab e troca com a seta
      if (ult === "texto" || ult === "select") p.push({ k: [KEY.TAB] }, { k: [KEY.ARROW_RIGHT] });
      else if (prev) p.push({ c: [prev.cx, prev.cy] }, { k: [KEY.TAB] }, { k: [KEY.ARROW_RIGHT] });
      else { nao.push(c); continue; }
      ult = "select";
    } else { nao.push(c); ult = null; }
  }
  if (modo === "valido") for (const m of [...marcaveis].sort(ordem)) { if (!/sms|desabilit/i.test(m.text)) p.push({ c: [m.cx, m.cy] }); }
  return { passos: p, naoSuportados: nao };
}

function prepararForm(tela) {
  if (tela.form) return tela.form;
  const els = tela.elementos;
  const campos = els.filter((e) => e.kind === "campo");
  if (campos.length < 2) return null;
  const F = { hora: hora(), campos, marcaveis: els.filter((e) => e.kind === "marcavel"),
    enviar: els.find((e) => e.kind === "botao" && SUBMIT.test(e.text)), limpar: els.find((e) => e.kind === "botao" && LIMPAR.test(e.text)),
    cenarios: {}, shots: {}, naoSuportados: [] };
  tela.form = F; return F;
}
const shot = (tela, F, nome, b64, ocr = true) => { F.shots[nome] = registrar(tela, `f_${nome}`, b64, { ocr }); };

async function formVazio(w, tela) {
  const F = prepararForm(tela); await prepararTela(w, tela.url, tela.alturaExterna);
  shot(tela, F, "vazio", await estavel(w, 100), false);
  if (F.enviar) {
    const t = Date.now(); const h = hora();
    await w.clicar(F.enviar.cx, F.enviar.cy); await esperar(130);
    shot(tela, F, "A", await w.print(false)); F.cenarios.A = { hora: h, ms: Date.now() - t };
  } else {                       // sem botão de envio: digita + Enter em cada campo
    F.isolado = [];
    for (const c of F.campos.filter((x) => AMOSTRA[x.tipo]).slice(0, 8)) {
      const t = Date.now(); const h = hora(); const antes = await w.print(false);
      await w.sequencia([{ c: [c.cx, c.cy] }, { meta: "a" }, { t: AMOSTRA[c.tipo][0] }, { k: [KEY.ENTER] }]); await esperar(120);
      const depois = await w.print(false); const i = F.isolado.length;
      F.isolado.push({ campo: c, hora: h, ms: Date.now() - t, mudou: depois !== antes, arqAntes: registrar(tela, `i${i}_antes`, antes), arqDepois: registrar(tela, `i${i}_depois`, depois, { ocr: true }) });
      await w.recarregar(); await esperar(80);
    }
  }
}
async function formValido(w, tela) {
  const F = prepararForm(tela); if (!F.enviar) return; await prepararTela(w, tela.url, tela.alturaExterna); await esperar(100);
  const val = passosPreencher(F.campos, F.marcaveis, "valido"); F.naoSuportados = val.naoSuportados;
  let t = Date.now(); let h = hora();
  await w.sequencia(val.passos);
  F.cenarios.B = { hora: h, preencherMs: Date.now() - t, campos: val.passos.filter((p) => p.c).length };
  await esperar(50);
  shot(tela, F, "B_pre", await w.print(false));
  t = Date.now(); h = hora();
  await w.clicar(F.enviar.cx, F.enviar.cy); await esperar(150);
  shot(tela, F, "B_env", await w.print(false)); F.cenarios.B.enviar = { hora: h, ms: Date.now() - t };
}
async function formLimpar(w, tela) {
  const F = prepararForm(tela); if (!F.enviar || !F.limpar) return; await prepararTela(w, tela.url, tela.alturaExterna); await esperar(100);
  await w.sequencia(passosPreencher(F.campos, F.marcaveis, "valido").passos); await esperar(40);
  const t2 = Date.now(); const h2 = hora();
  await w.clicar(F.limpar.cx, F.limpar.cy); await esperar(90);
  shot(tela, F, "B_limpo", await w.print(false), false); F.cenarios.limpar = { hora: h2, ms: Date.now() - t2 };
}
async function formInvalido(w, tela) {
  const F = prepararForm(tela); if (!F.enviar) return; await prepararTela(w, tela.url, tela.alturaExterna); await esperar(100);
  await w.sequencia(passosPreencher(F.campos, F.marcaveis, "valido").passos);
  const t = Date.now(); const h = hora();
  await w.sequencia(passosPreencher(F.campos, F.marcaveis, "invalido").passos);
  await w.clicar(F.enviar.cx, F.enviar.cy); await esperar(150);
  shot(tela, F, "C_env", await w.print(false)); F.cenarios.C = { hora: h, ms: Date.now() - t };
}

// ---------------- pós-análise (paralela, fora dos laços de clique) ----------------
const dentro = (segs, x, y, w, h) => segs.filter((s) => s.x + s.w / 2 >= x - 4 && s.x + s.w / 2 <= x + w + 4 && s.y + s.h / 2 >= y - 2 && s.y + s.h / 2 <= y + h + 2);
const ERRO = /inválid|obrigat|erro|preench|informe|mín|precis|selecione|não coincid|fraca/i;
const SUCESSO = /sucesso|enviado|recebid|salvo|obrigad|conclu/i;
const sem = (s) => s.toLowerCase().replace(/\s+/g, "");
// OCR erra caracteres (q→g, @→&): compara por semelhança, e por dígitos nos campos com máscara
function semelhanca(a, b, cru = false) {
  a = sem(a); b = sem(b);
  if (!cru) { a = a.replace(/[^\p{L}\p{N}]/gu, ""); b = b.replace(/[^\p{L}\p{N}]/gu, ""); }
  if (!a.length || !b.length) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}
const digitos = (s) => s.replace(/\D/g, "");
const MASCARA = new Set(["telefone", "cpf", "cep", "dinheiro", "data", "hora"]);

async function posAnalise(telas) {
  await Promise.all(PEND);
  const ocr = {}; for (const [k, v] of OCR) ocr[k] = v;
  // regiões dos campos (vazio x preenchido) e Limpar x vazio
  const jobs = [];
  for (const t of telas) {
    const F = t.form; if (!F) continue;
    if (F.shots.vazio && F.shots.B_pre) jobs.push(img.difreg(F.shots.vazio, F.shots.B_pre, F.campos).then((o) => F.campos.forEach((c, i) => { c.mudouPixels = o[i]; })));
    if (F.shots.vazio && F.shots.B_limpo) jobs.push(img.comparar(F.shots.vazio, F.shots.B_limpo).then((r) => { F.cenarios.limpar.igualVazio = r < 0.004; F.cenarios.limpar.diferenca = r; }));
  }
  await Promise.all(jobs);
  for (const t of telas) {
    const conhecidos = new Set(t.elementos.map((e) => sem(e.text)));
    for (const b of t.botoes) {
      const segs = b.arqDepois ? (ocr[b.arqDepois] ?? []) : [];
      b.textosNovos = segs.map((s) => s.text).filter((x) => x.length > 2 && !conhecidos.has(sem(x))).slice(0, 12);
      b.veredito = b.navegou ? "navegou" : b.real ? "reagiu" : "sem_reacao";
      b.notas = [];
      if (b.real && !b.restaurou) b.notas.push("a tela não voltou ao estado anterior depois do teste");
      if (b.real && b.tentativas.length === 0 && b.reagirMs > 1000) b.notas.push(`resposta lenta (${b.reagirMs} ms)`);
      if (b.navegou && /404|not found|não foi possível|unable to connect|server not found|problema ao carregar/i.test(b.textosNovos.join(" "))) b.notas.push("a tela de destino parece ser uma página de erro");
    }
    if (t.form) avaliarFormulario(t, ocr, conhecidos);
  }
}

function avaliarFormulario(t, ocr, conhecidos) {
  const F = t.form; const R = (F.resultados = { campos: [], obrigatorios: [], invalidos: [], envio: {} });
  const segsPre = ocr[F.shots.B_pre] ?? [], segsA = ocr[F.shots.A] ?? [], segsC = ocr[F.shots.C_env] ?? [], segsB = ocr[F.shots.B_env] ?? [];
  const msgAbaixo = (segs, c) => dentro(segs, c.x, c.y + c.h - 2, c.w, 84).map((s) => s.text).filter((x) => !conhecidos.has(sem(x)) && x.length > 3);
  for (const c of F.campos) {
    const a = AMOSTRA[c.tipo];
    const lido = dentro(segsPre, c.x, c.y, c.w, c.h).map((s) => s.text).join(" ").trim();
    let aceitou = null, mascaraOk = null;
    if (a) {
      const esp = a[1];
      if (c.tipo === "senha") aceitou = (c.mudouPixels ?? 0) > 0.002 || lido.length > 0;
      else {
        const contem = sem(lido).includes(sem(esp));
        if (MASCARA.has(c.tipo)) { aceitou = contem || digitos(lido).includes(digitos(esp)) && digitos(esp).length > 0; mascaraOk = aceitou ? (contem || semelhanca(lido, esp, true) >= 0.85) : null; }
        else aceitou = contem || semelhanca(lido, esp) >= 0.7 || semelhanca(lido.slice(0, esp.length + 2), esp) >= 0.7;
        if (!aceitou && (c.mudouPixels ?? 0) > 0.01 && (!lido || semelhanca(lido, c.text ?? "") < 0.6)) { aceitou = true; mascaraOk = null; }   // o campo mudou, o OCR é que não leu bem
      }
    }
    R.campos.push({ campo: c, esperado: a?.[1] ?? "", lido, aceitou, mascaraOk, suportado: !!a || c.tipo === "selecao" });
    if (c.obrigatorio) {
      const m = msgAbaixo(segsA, c);
      R.obrigatorios.push({ campo: c, mensagem: m.join(" "), ok: m.some((x) => ERRO.test(x)) || m.length > 0 });
    }
    if (a && a[2] != null && !/confirm/i.test(c.rotulo)) {
      const m = msgAbaixo(segsC, c);
      R.invalidos.push({ campo: c, valor: a[2], mensagem: m.join(" "), ok: m.length > 0 });
    }
  }
  const novosB = segsB.map((s) => s.text).filter((x) => !conhecidos.has(sem(x)));
  R.envio = { sucesso: novosB.some((x) => SUCESSO.test(x)), textos: novosB.slice(0, 10), erros: novosB.filter((x) => ERRO.test(x)).slice(0, 10) };
  for (const s of F.isolado ?? []) { s.textosNovos = (ocr[s.arqDepois] ?? []).map((x) => x.text).filter((x) => !conhecidos.has(sem(x))).slice(0, 8); }
}

// ---------------- bugs ----------------
function bugs(telas) {
  const B = [];
  const add = (hora, sev, tela, titulo, detalhe = "", contexto = {}) => B.push({ hora, sev, tela: tela.titulo || tela.url, titulo, detalhe,
    status: "suspeita", esperado: "Não especificado por requisito; revisar a evidência visual.",
    reproducao: { url: tela.url, estadoInicial: "Página carregada em instância de teste", passos: ["Abrir a URL", ...(/vazio|obrigatoriedade/.test(titulo) ? ["Manter os campos vazios", `Clicar em ${tela.form?.enviar?.text ?? "enviar"}`] : /inválido/.test(titulo) ? ["Preencher os campos com os dados de teste", "Substituir pelo valor inválido indicado no achado", `Clicar em ${tela.form?.enviar?.text ?? "enviar"}`] : ["Preencher os campos com os dados de teste", titulo.includes("início") ? `Clicar em ${tela.form?.limpar?.text ?? "Limpar"}` : "Executar a ação indicada no achado"]), "Comparar as evidências"], dadosTeste: (tela.form?.campos ?? []).filter((c) => AMOSTRA[c.tipo]).map((c) => ({ campo: c.rotulo, valor: AMOSTRA[c.tipo][0] })), observado: detalhe || titulo },
    evidencias: Object.values(tela.form?.shots ?? {}), ...contexto });
  for (const t of telas) {
    for (const b of t.botoes) {
      const e = b.elemento; const nome = `“${e.text}” (x=${e.cx}, y=${e.cy})`;
      if (b.veredito === "sem_reacao" && e.kind === "botao" && !LIMPAR.test(e.text) && !/^MS$/.test(e.text)) add(b.hora, "média", t, `Botão ${nome} não mostra reação ao clique`, `Nenhuma mudança observada após ${b.tentativas?.length ?? 1} observação(ões), em ${b.reagirMs} ms; pode ser uma ação sem efeito visual esperado.`, {
        status: "inconclusivo", esperado: "Depende do requisito do controle; uma opção já selecionada pode não mudar a tela.",
        reproducao: { url: t.url, estadoInicial: "Página carregada; sem preenchimento prévio", passos: [`Clicar em ${nome}`, "Retirar o ponteiro e aguardar 1200 ms", ...(b.tentativas?.length > 1 ? ["Reabrir a URL e repetir o clique, aguardando mais 1200 ms"] : [])], observado: "Nenhuma mudança visual ou de URL" },
        evidencias: [b.arqAntes, b.arqDepois, ...(b.tentativas ?? []).flatMap((x) => [x.arqAntes, x.arqDepois])].filter(Boolean),
      });
      for (const n of b.notas) add(b.hora, /erro|não voltou/.test(n) ? "alta" : "baixa", t, `${nome}: ${n}`, n, {
        reproducao: { url: t.url, estadoInicial: "Página carregada", passos: ["Abrir a URL", `Clicar em ${nome}`, "Aguardar e comparar a tela de destino e a restauração"], observado: n },
        evidencias: [b.arqAntes, b.arqDepois],
      });
    }
    const F = t.form; if (!F) continue;
    const R = F.resultados; if (!R) continue;
    for (const o of R.obrigatorios) if (F.cenarios.A && !o.ok) add(F.cenarios.A?.hora ?? F.hora, "alta", t, `Mensagem de obrigatoriedade não detectada em “${o.campo.rotulo}” após envio vazio`);
    for (const c of R.campos) {
      if (F.cenarios.B && c.aceitou === false) add(F.cenarios.B?.hora ?? F.hora, "alta", t, `Campo “${c.campo.rotulo}” não aceitou o valor digitado`, `esperado “${c.esperado}”, lido “${c.lido}”`);
      else if (c.mascaraOk === false && c.aceitou) add(F.cenarios.B?.hora ?? F.hora, "média", t, `Campo “${c.campo.rotulo}” mostra formato diferente do esperado`, `esperado “${c.esperado}”, lido “${c.lido}”`);
    }
    for (const i of R.invalidos) if (F.cenarios.C && !i.ok) add(F.cenarios.C?.hora ?? F.hora, "alta", t, `Aviso não detectado para o valor inválido “${i.valor}” em “${i.campo.rotulo}”`);
    if (F.cenarios.B?.enviar && !R.envio.sucesso) add(F.cenarios.B?.enviar?.hora ?? F.hora, "alta", t, "Envio com dados válidos não mostrou confirmação de sucesso", R.envio.erros.length ? `Mensagens: ${R.envio.erros.join(" | ")}` : "");
    if (F.cenarios.limpar && !F.cenarios.limpar.igualVazio) add(F.cenarios.limpar.hora, "média", t, `Botão “${F.limpar.text}” não deixou o formulário como no início`);
  }
  return B.sort((a, b) => a.hora.localeCompare(b.hora));
}

// ---------------- execução ----------------
// Descobre a aba certa no Firefox do usuário e prepara a cópia da sessão (login). Nunca devolve valores de cookies.
export function resolverSessao({ url, aba, sessao = "auto" }) {
  const info = { modo: sessao, usada: false, aviso: "" };
  if (sessao === "nenhuma") return { url, info, copia: null };
  const perfil = perfilAtivo();
  if (!perfil) { info.erro = perfilAtivo.codigoErro ? { codigo: perfilAtivo.codigoErro, mensagem: perfilAtivo.erro } : null; info.aviso = perfilAtivo.erro ?? "não encontrei o perfil do Firefox em uso"; return { url, info, copia: null }; }
  let abas; try { abas = abasAbertas(perfil); } catch (e) { info.erro = { codigo: e.code ?? "SESSAO_ILEGIVEL", mensagem: "Não foi possível ler a sessão do Firefox: " + e.message }; info.aviso = info.erro.mensagem; return { url, info, copia: null }; }
  const r = localizarAba(abas, { url, trecho: aba });
  info.abasAbertas = abas.filter((a) => !/^(about|moz-extension|chrome):/.test(a.url)).length; info.motivo = r.motivo; info.candidatas = r.candidatas;
  if (!r.aba) { info.aviso = `${r.motivo}: o teste abre o endereço sem a sua sessão (se a página pedir login, abra-a logada no Firefox e rode de novo)`; return { url, info, copia: null }; }
  info.aba = resumo(r.aba); info.usada = true;
  return { url: url ?? r.aba.url, info, copia: { perfilOrigem: perfil, url: url ?? r.aba.url } };
}

export async function executarQA({ url, dirBase, maxTelas = 5, modo = "completo", sessao = null, sessaoInfo = null, zoom = true }) {
  const fases = {};
  fases.aquecimentoMs = await aquecer(4, sessao, zoom);
  const T1 = Date.now(); const m1 = (k) => { fases[k] = Date.now() - T1; };
  OCR.clear(); MINI.clear(); PEND.length = 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(dirBase, stamp); mkdirSync(dir, { recursive: true });
  const telas = []; const visit = new Set(); const pendentes = new Set();
  const fila = []; let ativos = 0, zoomAtivos = 0, ociosoDesde = 0; const ctls = [];
  const trace = [];
  const enfileirar = (t, frente = false, nome = "tarefa") => { t.nome = nome; frente ? fila.unshift(t) : fila.push(t); };

  const novaTela = (u) => {                       // descoberta durante os cliques: já mapeia em paralelo
    if (!/^(file|https?):/.test(u) || visit.has(norm(u))) return;
    if (visit.size >= maxTelas) { pendentes.add(u); return; }
    visit.add(norm(u)); enfileirar((w) => mapearEAgendar(w, u), true, "mapear " + u.split("/").pop());
  };
  const mapearEAgendar = async (w, u) => {
    const idx = telas.length + 1; const placeholder = { dir: "" }; telas.push(placeholder);
    const t = await mapear(w, u, join(dir, `tela${idx}`));
    telas[telas.indexOf(placeholder)] = t; m1(`mapear_${idx}`);
    const temForm = t.elementos.filter((e) => e.kind === "campo").length >= 2;
    let todos = t.elementos.filter((e) => ["botao", "item", "link", "acordeao"].includes(e.kind) && e.w > 8 && /[\p{L}\p{N}]/u.test(e.text));
    if (temForm) todos = todos.filter((e) => !(SUBMIT.test(e.text) || LIMPAR.test(e.text)));   // já cobertos pelos cenários do formulário
    if (modo === "rapido") { const u = new Set(); todos = todos.filter((e) => (u.has(e.text) ? false : (u.add(e.text), true))); }   // um representante por texto de botão
    const vistos = new Map(); todos.forEach((e) => vistos.set(e.text, (vistos.get(e.text) ?? 0) + 1));
    const seen = new Set();   // primeiro os textos que aparecem uma vez (ações distintas), depois as repetições
    const alvos = [...todos.filter((e) => vistos.get(e.text) === 1 || !seen.has(e.text) && seen.add(e.text)), ...todos.filter((e) => vistos.get(e.text) > 1 && !(seen.has(e.text) && todos.indexOf(e) === todos.findIndex((x) => x.text === e.text)))];
    const lotes = Array.from({ length: Math.min(3, alvos.length) }, () => []);
    alvos.forEach((e, i) => lotes[i % lotes.length].push(e));
    for (const lote of lotes) enfileirar((w2) => testarBotoes(w2, t, lote, novaTela), true, `botões[${lote.map((e) => e.text).join("|").slice(0, 40)}]`);
    if (zoom) {   // fora do caminho crítico: a lupa é uma instância própria; só os botões novos que ela achar são testados depois
      zoomAtivos++;
      const ctl = { cancelado: false }; ctls.push(ctl);
      refinarComZoom(t, t.url, ctl).then(() => { m1(`zoom_${idx}`); const novos = (t.zoom.novos ?? []).map((n) => t.elementos.find((e) => e.id === n.id)).filter(Boolean); if (novos.length) enfileirar((w2) => testarBotoes(w2, t, novos, novaTela), true, "botões(zoom)"); })
        .catch((e) => { t.zoom = { erro: e.message }; }).finally(() => { zoomAtivos--; });
    }
    if (t.elementos.filter((e) => e.kind === "campo").length >= 2) {
      enfileirar((w2) => formValido(w2, t), true, "formB"); enfileirar((w2) => formInvalido(w2, t), true, "formC"); enfileirar((w2) => formVazio(w2, t), true, "formA"); enfileirar((w2) => formLimpar(w2, t), false, "formD");
    }
  };
  visit.add(norm(url)); enfileirar((w) => mapearEAgendar(w, url), false, "mapear inicial");
  await Promise.all(pool.map(async (w) => {
    for (;;) {
      const t = fila.shift();
      if (!t) {
        if (ativos === 0 && zoomAtivos === 0) return;
        if (ativos === 0) { ociosoDesde ||= Date.now(); if (Date.now() - ociosoDesde > ESPERA_ZOOM) { ctls.forEach((c) => { c.cancelado = true; }); return; } }   // o zoom não segura o relatório
        await esperar(8); continue;
      }
      ociosoDesde = 0;
      const ti = Date.now() - T1; ativos++; try { await t(w); } finally { ativos--; trace.push(`w${pool.indexOf(w)} ${t.nome} ${ti}-${Date.now() - T1}`); }
    }
  }));
  m1("testesTotal");
  await lupaFila.catch(() => {});
  const avisos = [];
  const t0 = telas[0];
  if (t0 && t0.elementos.some((e) => e.kind === "campo" && e.tipo === "senha") && t0.elementos.some((e) => /^(entrar|login|log in|sign in|acessar|fazer login)$/i.test(e.text.trim()))) avisos.push("A primeira tela parece ser uma tela de login. Se a página exige login, abra-a já logada no seu Firefox e rode o teste de novo para que a sessão seja copiada.");
  await posAnalise(telas);
  m1("posAnalise");
  const lista = bugs(telas);
  fases.trace = trace;
  const res = { hora: hora(), urlInicial: url, totalMs: Date.now() - T1, backend: img.nomeBackend, sistema: process.platform, modo, zoom, sessaoInfo: sessaoInfo && { ...sessaoInfo, copia: pool[0]?.copiaSessao ? { site: pool[0].copiaSessao.host, cookiesCopiados: !!pool[0].copiaSessao.cookies, origensStorage: pool[0].copiaSessao.storage, cookiesDeSessao: pool[0].copiaSessao.sessao?.length ?? 0 } : null }, avisos, mini: Object.fromEntries(MINI), fases, telas: telas.map(({ base, ...r }) => r), bugs: lista, dir };
  res.cobertura = cobertura(telas, pendentes, modo, maxTelas);
  res.schemaVersion = 2;
  writeFileSync(join(dir, "resultado.json"), JSON.stringify(portatil(res, dir), null, 1));
  return res;
}
