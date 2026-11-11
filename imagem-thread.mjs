// Thread de trabalho do backend portátil: todo o processamento pesado de pixels fica fora do laço principal.
import { parentPort } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { lerPNG, gravarPNG, reduzir } from "./png.mjs";
import { analisar, agrupar } from "./analise.mjs";

const cache = new Map();
function abrir(png) {
  if (cache.has(png)) return cache.get(png);
  const img = lerPNG(readFileSync(png));
  cache.set(png, img); if (cache.size > 4) cache.delete(cache.keys().next().value);
  return img;
}

// texto sempre escuro sobre branco, por contraste local; depois remove traços retos longos (bordas e molduras)
function normalizar(img) {
  const { w, h, d } = img, g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  const C = 24, cw = Math.ceil(w / C), ch = Math.ceil(h / C), fundo = new Uint8Array(cw * ch), hist = new Uint32Array(32);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    hist.fill(0);
    for (let y = cy * C; y < Math.min(h, cy * C + C); y += 2) for (let x = cx * C; x < Math.min(w, cx * C + C); x += 2) hist[g[y * w + x] >> 3]++;
    let m = 0; for (let k = 1; k < 32; k++) if (hist[k] > hist[m]) m = k;
    fundo[cy * cw + cx] = m * 8 + 4;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const linha = Math.floor(y / C) * cw; for (let x = 0; x < w; x++) { const v = 255 - Math.abs(g[y * w + x] - fundo[linha + Math.floor(x / C)]) * 3; out[y * w + x] = v < 0 ? 0 : v; } }
  const LIM = 150, RUN = 70;
  for (let y = 0; y < h; y++) { let ini = -1; const o = y * w; for (let x = 0; x <= w; x++) { const esc = x < w && out[o + x] < LIM; if (esc && ini < 0) ini = x; else if (!esc && ini >= 0) { if (x - ini >= RUN) out.fill(255, o + ini, o + x); ini = -1; } } }
  for (let x = 0; x < w; x++) { let ini = -1; for (let y = 0; y <= h; y++) { const esc = y < h && out[y * w + x] < LIM; if (esc && ini < 0) ini = y; else if (!esc && ini >= 0) { if (y - ini >= RUN) for (let k = ini; k < y; k++) out[k * w + x] = 255; ini = -1; } } }
  return out;
}

const ops = {
  faixas({ png }) {            // PNGs em tons de cinza, em faixas sobrepostas, prontos para o OCR
    const img = abrir(png), cinza = normalizar(img), FAIXA = 1400, SOBRE = 120, faixas = [];
    for (let y = 0; y < img.h; y += FAIXA - SOBRE) {
      let hh = Math.min(FAIXA, img.h - y);
      if (img.h - (y + hh) < 300) hh = img.h - y;
      faixas.push({ y, png: gravarPNG(img.w, hh, cinza.subarray(y * img.w, (y + hh) * img.w), 1) });
      if (y + hh >= img.h) break;
    }
    return { w: img.w, h: img.h, faixas };
  },
  segs({ linhas }) { return dedup(agrupar(linhas)); },
  analisar({ png, linhas }) { const img = abrir(png); return { w: img.w, h: img.h, elementos: analisar(img, dedup(agrupar(linhas)), 2) }; },
  difreg({ a, b, rects }) {
    const A = abrir(a), B = abrir(b);
    return rects.map((r) => {
      if (A.w !== B.w || A.h !== B.h) return 1;
      let n = 0, t = 0; const x0 = Math.max(0, r.x * 2), y0 = Math.max(0, r.y * 2), x1 = Math.min(A.w, x0 + r.w * 2), y1 = Math.min(A.h, y0 + r.h * 2);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * A.w + x) * 4; t++; if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) > 40) n++; }
      return t ? n / t : 0;
    });
  },
  tamanho({ png }) { const i = abrir(png); return { w: i.w, h: i.h }; },
  mini({ png, largura }) { const m = reduzir(abrir(png), largura); const out = png.replace(/\.png$/, ".mini.png"); writeFileSync(out, gravarPNG(m.w, m.h, m.d, 4)); return out; },
};
function dedup(segs) { const out = []; for (const s of segs) if (!out.some((o) => o.text === s.text && Math.abs(o.y - s.y) < 8 && Math.abs(o.x - s.x) < 8)) out.push(s); return out; }

parentPort.on("message", ({ id, op, args }) => {
  try { parentPort.postMessage({ id, ok: ops[op](args) }); } catch (e) { parentPort.postMessage({ id, erro: e.message }); }
});
