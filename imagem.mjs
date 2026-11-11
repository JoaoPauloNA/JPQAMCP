// Backend de imagem do QA. Dois motores com a mesma interface:
//   nativo  — helper Swift (fxctl) com o OCR Vision da Apple: só macOS, mais rápido e mais preciso
//   portátil — JS puro (png.mjs + analise.mjs) com tesseract.js: Windows, Linux e macOS
// Escolha: FX_BACKEND=js|nativo; por padrão usa o nativo quando existe.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Worker } from "node:worker_threads";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FX = join(AQUI, "fxctl");
export const NATIVO = process.env.FX_BACKEND !== "js" && process.platform === "darwin" && existsSync(FX);
export const nomeBackend = NATIVO ? "nativo (Vision/macOS)" : "portátil (tesseract.js)";
export const fx = (args, env = {}) => new Promise((res, rej) =>
  execFile(FX, args, { maxBuffer: 1 << 28, env: { ...process.env, ...env } }, (e, o, er) => (e ? rej(new Error((er || e.message).trim())) : res(o))));

// ---------------- portátil ----------------
// Pixels em threads (não travam o laço que comanda o Firefox); OCR no agendador do tesseract.js (que usa as próprias threads).
let threads = null, seq = 0; const espera = new Map();
function pool() {
  if (threads) return threads;
  const n = Math.max(2, Math.min(4, os.cpus().length - 2));
  threads = Array.from({ length: n }, () => {
    const t = new Worker(new URL("./imagem-thread.mjs", import.meta.url));
    t.on("message", ({ id, ok, erro }) => { const p = espera.get(id); espera.delete(id); erro ? p.rej(new Error(erro)) : p.res(ok); });
    t.unref();
    return t;
  });
  return threads;
}
// a mesma imagem vai sempre para a mesma thread (aproveita o cache de decodificação)
function th(chave, op, args) {
  const ts = pool(); let h = 0; for (const c of chave) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new Promise((res, rej) => { const id = ++seq; espera.set(id, { res, rej }); ts[h % ts.length].postMessage({ id, op, args }); });
}

let agenda = null;
async function tesseract() {
  if (agenda) return agenda;
  const { createScheduler, createWorker } = await import("tesseract.js");
  const s = createScheduler(); const n = Math.max(2, Math.min(4, os.cpus().length - 2));
  await Promise.all(Array.from({ length: n }, async () => {
    const w = await createWorker("por", 1, { cachePath: join(AQUI, ".tessdata") });
    await w.setParameters({ tessedit_pageseg_mode: "11" });
    s.addWorker(w);
  }));
  return (agenda = s);
}
export async function prepararBackend() { if (!NATIVO) { pool(); await tesseract(); } }

async function linhasOCR(png) {   // palavras por linha, em px
  const [s, f] = await Promise.all([tesseract(), th(png, "faixas", { png })]);
  const conf = Number(process.env.FX_OCR_CONF ?? 40);
  const res = await Promise.all(f.faixas.map(({ y, png: buf }) => s.addJob("recognize", Buffer.from(buf), {}, { blocks: true }).then((r) => ({ y, r }))));
  const linhas = [];
  for (const { y, r } of res) for (const b of r.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const ws = l.words.filter((x) => x.confidence > conf && x.text.trim()).map((x) => ({ text: x.text.trim(), x: x.bbox.x0, y: x.bbox.y0 + y, w: x.bbox.x1 - x.bbox.x0, h: x.bbox.y1 - x.bbox.y0, conf: x.confidence / 100 })).sort((a, b) => a.x - b.x);
    if (ws.length) linhas.push(ws);
  }
  return linhas;
}

// ---------------- interface ----------------
export async function analisar(png, dir) {
  if (NATIVO) { await fx(["analisar", png, dir], { FX_SEM_MALHA: "1" }); return JSON.parse(readFileSync(join(dir, "resultado.json"), "utf8")); }
  const t0 = Date.now();
  const r = await th(png, "analisar", { png, linhas: await linhasOCR(png) });
  const d = { paginaW: r.w / 2, paginaH: r.h / 2, analiseMs: Date.now() - t0, elementos: r.elementos };
  writeFileSync(join(dir, "resultado.json"), JSON.stringify(d));
  return d;
}
export async function ocr(png) {       // [{text, x, y, w, h}] em pontos
  if (NATIVO) return JSON.parse(await fx(["ocr", png]))[png] ?? [];
  const segs = await th(png, "segs", { linhas: await linhasOCR(png) });
  return segs.filter((s) => s.text !== "◯").map((s) => ({ text: s.text, x: Math.floor(s.x / 2), y: Math.floor(s.y / 2), w: Math.floor(s.w / 2), h: Math.floor(s.h / 2) }));
}
export async function difreg(a, b, rects) {   // fração de pixels diferentes em cada região (pontos)
  if (NATIVO) return JSON.parse(await fx(["difreg", a, b, ...rects.flatMap((r) => [r.x, r.y, r.w, r.h])]));
  return th(a, "difreg", { a, b, rects: rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })) });
}
export async function comparar(a, b) {        // fração de pixels diferentes na imagem inteira
  if (NATIVO) return JSON.parse(await fx(["comparar", a, b]))[0].ratio;
  const t = await th(a, "tamanho", { png: a });
  return (await difreg(a, b, [{ x: 0, y: 0, w: t.w / 2, h: t.h / 2 }]))[0];
}
export async function miniatura(png, largura = 560) {   // devolve o caminho da miniatura
  if (NATIVO) { const jpg = png.replace(/\.png$/, ".jpg"); await fx(["miniaturas", String(largura), png, jpg]); return jpg; }
  return th(png, "mini", { png, largura });
}
export async function encerrarBackend() {
  if (agenda) { await agenda.terminate(); agenda = null; }
  if (threads) { await Promise.all(threads.map((t) => t.terminate())); threads = null; }
}
