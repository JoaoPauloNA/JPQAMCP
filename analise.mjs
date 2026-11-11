// Detecção de elementos só por pixels (porte em JS do helper nativo). Entrada: imagem RGBA + segmentos de texto do OCR (em px).
// Saída: elementos com tipo (botao, campo, marcavel, acordeao, etiqueta, item, link, texto), rótulo e tipo de dado.

const MARCA = "◯";
export const MARCADORES = new Set(["•", "O", "o", "0", "Q", "□", "☐", "▢", "◯", "○", "[]", "©", "®", "()", "»", ">", "›", "▸", "▶", "►"]);

// ---------- pixels ----------
function fab(img) {
  const { w, d } = img;
  const dist = (x1, y1, r, g, b) => { const i = (y1 * w + x1) * 4; return Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b); };
  const at = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const cd = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  return { dist, at, cd };
}

// caixa (botão/campo) ao redor de um texto
function enclose(img, r) {
  const { dist, at, cd } = fab(img);
  const x0 = Math.floor(r.x), x1 = Math.floor(r.x + r.w), y0 = Math.floor(r.y), y1 = Math.floor(r.y + r.h);
  const mx = (x0 + x1) >> 1, my = (y0 + y1) >> 1;
  if (!(x0 - 6 >= 0 && y0 - 6 >= 0 && x1 + 6 < img.w && y1 + 6 < img.h && x1 > x0 && y1 > y0)) return null;
  const inner = at(x0 - 4, my);
  if (cd(inner, at(mx, y0 - 4)) > 24 || cd(inner, at(mx, y1 + 4)) > 24) return null;
  const T = 28;
  const vline = (x) => { if (x < 0 || x >= img.w) return false; let n = 0, t = 0; for (let y = y0; y <= y1; y++) { t++; if (dist(x, y, ...inner) > T) n++; } return n / Math.max(t, 1) >= 0.7; };
  const hline = (y) => { if (y < 0 || y >= img.h) return false; let n = 0, t = 0; for (let x = x0; x <= x1; x++) { t++; if (dist(x, y, ...inner) > T) n++; } return n / Math.max(t, 1) >= 0.7; };
  let dL = 0, dR = 0, dT = 0, dB = 0;
  for (let k = 4; k <= 64; k++) if (vline(x0 - k)) { dL = k; break; }
  for (let k = 4; k <= 64; k++) if (vline(x1 + k)) { dR = k; break; }
  for (let k = 4; k <= 44; k++) if (hline(y0 - k)) { dT = k; break; }
  for (let k = 4; k <= 44; k++) if (hline(y1 + k)) { dB = k; break; }
  if (dB === 0 && dT > 0) for (let k = 45; k < 230; k++) if (hline(y1 + k)) { dB = k; break; }
  // botão preenchido de largura total: o texto fica longe das bordas laterais, mas centralizado
  if (dT > 0 && dB > 0 && (dL === 0 || dR === 0)) {
    let wl = dL, wr = dR;
    if (!wl) for (let k = 65; k < 1500; k++) if (vline(x0 - k)) { wl = k; break; }
    if (!wr) for (let k = 65; k < 1500; k++) if (vline(x1 + k)) { wr = k; break; }
    if (wl && wr) { const q = wl / wr, foraE = at(Math.max(0, x0 - wl - 4), my), foraD = at(Math.min(img.w - 1, x1 + wr + 4), my); if (q >= 0.7 && q <= 1.4 && cd(inner, foraE) >= 60 && cd(inner, foraD) >= 60 && cd(inner, [255, 255, 255]) >= 60) { dL = wl; dR = wr; } }
  }
  if (!(dL > 0 && dT > 0 && dB > 0)) return null;
  // borda de container continua além do retângulo; borda de botão/campo termina nos cantos
  const bx = x0 - dL, by0 = y0 - dT, by1 = y1 + dB, mid = (by0 + by1) >> 1;
  if (bx - 1 >= 0 && by0 - 8 >= 0 && by1 + 8 < img.h) {
    const edge = at(bx, mid), fora = at(Math.max(0, bx - 4), mid);
    // tolera 2 px de deslocamento: a linha do container pode cair numa coluna vizinha
    const continua = (yy) => { for (let o = -2; o <= 2; o++) if (bx + o >= 0 && cd(at(bx + o, yy), edge) < 14) return true; return false; };
    if (cd(edge, fora) >= 20 && continua(by0 - 8) && continua(by1 + 8)) return null;
  }
  let aberto = false;
  if (dR === 0) {
    for (let k = 65; k < 1500; k++) if (vline(x1 + k)) { dR = k; break; }
    if (dR === 0) return null;
    aberto = true;
    // botão preenchido de largura total: texto centralizado e cor de preenchimento bem diferente do entorno
    const q = dL / dR, fora = at(Math.max(0, x0 - dL - 4), my);
    if (q >= 0.7 && q <= 1.4 && cd(inner, fora) >= 60 && cd(inner, [255, 255, 255]) >= 60) aberto = false;
  } else { const q = dL / dR; if (q < 0.4 || q > 2.5) return null; }
  const box = { x: x0 - dL, y: y0 - dT, w: x1 + dR - (x0 - dL) + 1, h: y1 + dB - (y0 - dT) + 1 };
  if (aberto) {
    const bx0 = box.x, bx1 = box.x + box.w - 1, bY0 = box.y, bY1 = box.y + box.h - 1;
    if (!(bx1 < img.w && bY1 < img.h && bx1 - bx0 > 40 && bY1 - bY0 > 20)) return null;
    const frac = (pts) => pts.filter(([x, y]) => dist(x, y, ...inner) > T).length / Math.max(pts.length, 1);
    const hs = [], hb = [], vl = [], vr = [];
    for (let x = bx0 + 12; x < bx1 - 12; x += 2) { hs.push([x, bY0]); hb.push([x, bY1]); }
    for (let y = bY0 + 12; y < bY1 - 12; y += 2) { vl.push([bx0, y]); vr.push([bx1, y]); }
    if (frac(hs) < 0.97 || frac(hb) < 0.97 || frac(vl) < 0.85 || frac(vr) < 0.85) return null;   // duas caixas lado a lado (94%) não formam uma linha contínua
  }
  return { rect: box, aberto };
}

function textoAzul(img, r) {
  const { at, cd } = fab(img);
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(img.w - 1, Math.floor(r.x + r.w)), y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(img.h - 1, Math.floor(r.y + r.h));
  if (!(x1 > x0 && y1 > y0 && x0 - 4 >= 0)) return false;
  const bg = at(x0 - 4, (y0 + y1) >> 1); let best = 0, bc = bg;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const c = at(x, y), dd = cd(c, bg); if (dd > best) { best = dd; bc = c; } }
  return best > 120 && bc[2] > bc[0] + 50 && bc[2] > bc[1] + 15;
}

// ---------- tipos e amostras ----------
export function inferTipo(rotulo, texto, hpt) {
  const s = (rotulo + " " + texto).toLowerCase();
  const tem = (...k) => k.some((x) => s.includes(x));
  if (tem("busca", "pesquis", "search", "buscar")) return "busca";
  if (tem("e-mail", "email")) return "email";
  if (tem("telefone", "celular", "whatsapp")) return "telefone";
  if (tem("cpf")) return "cpf";
  if (tem("cep")) return "cep";
  if (tem("senha", "password")) return "senha";
  if (tem("selecione", "país", "pais", "estado", "plano", "idiomas")) return "selecao";
  if (tem("data e hora", "reunião")) return "datahora";
  if (tem("mês", "mes de")) return "mes";
  if (tem("semana")) return "semana";
  if (tem("horário", "hora", "--:--")) return "hora";
  if (tem("dd/mm", "nascimento", "data")) return "data";
  if (tem("r$", "salári", "salari", "valor")) return "dinheiro";
  if (tem("site", "url", "http")) return "url";
  if (tem("número", "numero", "quantidade")) return "numero";
  if (hpt > 60) return "textolongo";
  if (tem("usuário", "usuario", "login")) return "usuario";
  if (tem("nome")) return "nome";
  return "texto";
}

// ---------- campos pelo rótulo acima + retângulo fechado ----------
function camposPorRotulo(img, els) {
  const { dist, at } = fab(img); const out = []; const T = 28;
  for (const el of els) {
    if (el.kind !== "texto" || el.r.h >= 44 || el.text.length < 2 || el.text.length > 45) continue;
    const lx = Math.floor(el.r.x), ly1 = Math.floor(el.r.y + el.r.h);
    if (!(lx - 8 >= 0 && lx + 400 < img.w && ly1 + 260 < img.h)) continue;
    if (els.some((o) => ["campo", "botao", "acordeao"].includes(o.kind) && o.r.y > el.r.y + el.r.h - 4 && o.r.y - (el.r.y + el.r.h) < 70 && o.r.x < el.r.x + el.r.w + 60 && o.r.x + o.r.w > el.r.x)) continue;
    const bg = at(lx - 4, (Math.floor(el.r.y) + ly1) >> 1);
    const hl = (y, xa, xb) => { let n = 0, t = 0; for (let x = xa; x < xb; x += 2) { t++; if (dist(x, y, ...bg) > T) n++; } return n / Math.max(t, 1) >= 0.9; };
    const vl = (x, ya, yb) => { let n = 0, t = 0; for (let y = ya; y < yb; y += 2) { t++; if (dist(x, y, ...bg) > T) n++; } return n / Math.max(t, 1) >= 0.9; };
    let top = 0; for (let y = ly1 + 4; y <= ly1 + 60; y++) if (hl(y, lx + 14, lx + 90)) { top = y; break; }
    if (!top) continue;
    let bot = 0; for (let y = top + 40; y <= Math.min(img.h - 2, top + 220); y++) if (hl(y, lx + 14, lx + 90)) { bot = y; break; }
    if (!bot) continue;
    const inner = at(lx + 12, (top + bot) >> 1); let bad = 0, tot = 0;
    for (let yy = top + 14; yy < bot - 14; yy += 3) for (let xx = lx + 14; xx < lx + 700 && xx < img.w - 2; xx += 3) { tot++; if (dist(xx, yy, ...inner) > 30) bad++; }
    if (!tot || bad / tot > 0.12) continue;
    let left = -1; for (let x = Math.max(0, lx - 8); x <= lx + 6; x++) if (vl(x, top + 12, bot - 12)) { left = x; break; }
    if (left < 0) continue;
    let right = -1; for (let x = lx + 120; x < Math.min(img.w - 2, lx + 1500); x++) if (vl(x, top + 12, bot - 12)) { right = x; break; }
    if (right < 0) continue;
    const r = { x: left, y: top, w: right - left + 1, h: bot - top + 1 }, hpt = r.h / 2;
    if (r.w < 120 || hpt < 22 || hpt > 140) continue;
    const cruza = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    if (els.some((o) => o.kind !== "texto" && cruza(o.r, r)) || out.some((o) => cruza(o.r, r))) continue;
    const dentro = els.filter((o) => o.kind === "texto" && o.r.y + o.r.h / 2 > r.y && o.r.y + o.r.h / 2 < r.y + r.h && o.r.x + o.r.w / 2 > r.x && o.r.x + o.r.w / 2 < r.x + r.w);
    if (dentro.length > 3) continue;
    out.push({ kind: "campo", text: dentro.map((o) => o.text).join(" "), r, conf: 1 });
  }
  return out;
}

// checkbox/rádio: pequeno contorno vazado logo à esquerda de um texto
function marcaveisPorPixel(img, els) {
  const { dist, at } = fab(img); const out = [];
  for (const el of els) {
    if (el.kind !== "texto" || el.r.h >= 44 || el.text.length < 2) continue;
    const mid = Math.floor(el.r.y + el.r.h / 2), tx = Math.floor(el.r.x);
    if (!(tx - 52 >= 0 && mid - 22 >= 0 && mid + 22 < img.h && tx - 2 < img.w)) continue;
    const bg = at(tx - 3, mid); const cols = [];
    for (let x = tx - 3; x >= tx - 52; x--) { let n = 0; for (let y = mid - 22; y <= mid + 22; y++) if (dist(x, y, ...bg) > 30) n++; cols.push(n > 0); }
    let i = 0; while (i < cols.length && !cols[i]) i++;
    const ini = i; while (i < cols.length && cols[i]) i++;
    const larg = i - ini;
    if (ini > 14 || larg < 20 || larg > 44) continue;
    const xr = tx - 3 - ini, xl = tx - 3 - (i - 1);
    let y0 = Infinity, y1 = -1;
    for (let y = mid - 22; y <= mid + 22; y++) for (let x = xl; x <= xr; x++) if (dist(x, y, ...bg) > 30) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
    const h = y1 - y0 + 1;
    if (h < 20 || h > 44 || Math.abs(h - larg) > 8) continue;
    let dens = 0, tot = 0;
    for (let y = y0; y <= y1; y++) for (let x = xl; x <= xr; x++) { tot++; if (dist(x, y, ...bg) > 30) dens++; }
    const q = dens / Math.max(tot, 1);
    if (q < 0.08 || q > 0.75) continue;
    out.push({ kind: "marcavel", text: el.text, label: el.text, r: { x: xl, y: y0, w: larg, h }, conf: 1 });
  }
  return out;
}

const CIRILICO = { "С": "C", "Е": "E", "О": "O", "Р": "P", "А": "A", "Т": "T", "Х": "X", "Н": "H", "М": "M", "К": "K", "В": "B", "І": "I", "с": "c", "е": "e", "о": "o", "р": "p", "а": "a", "х": "x" };
function rotular(els) {
  for (const e of els) {
    if (e.kind === "marcavel" && e.text === MARCA) {
      const cand = els.filter((o) => o.kind === "texto" && o.r.x >= e.r.x + e.r.w - 4 && o.r.x - (e.r.x + e.r.w) < 60 && Math.abs(o.r.y + o.r.h / 2 - (e.r.y + e.r.h / 2)) < e.r.h).sort((a, b) => a.r.x - b.r.x)[0];
      e.text = e.label = cand ? cand.text : "(opção)"; e.req = !!cand?.text.includes("*");
    }
  }
  for (const e of els) {
    if (e.kind !== "campo") continue;
    let melhor = null, md = Infinity;
    for (const o of els) {
      if (o === e || o.kind !== "texto") continue;
      const dy = e.r.y - (o.r.y + o.r.h);
      if (dy < -4 || dy > 64 || o.r.x > e.r.x + e.r.w || o.r.x + o.r.w < e.r.x || Math.abs(o.r.x - e.r.x) > 90) continue;
      if (dy < md) { md = dy; melhor = o; }
    }
    let rot = melhor?.text ?? ""; e.req = rot.includes("*");
    rot = [...rot.replaceAll("*", "").trim()].map((c) => CIRILICO[c] ?? c).join("");
    e.label = rot; e.tipo = inferTipo(rot, e.text, e.r.h / 2);
  }
}

// ---------- OCR: palavras -> segmentos (separa botões vizinhos e marcadores) ----------
export function agrupar(linhas) {   // linhas: [[{text, x, y, w, h, conf}]]
  const out = [];
  for (let palavras of linhas) {
    palavras = palavras.filter((p) => !/^[|\\/_\-—–·.,:;!'`´‘’"“”()\[\]{}<>=~^]{1,3}$/.test(p.text) || p.text === "-" && false);
    if (!palavras.length) continue;
    let cur = null;
    palavras.forEach((p, i) => {
      const prox = palavras[i + 1];
      if (MARCADORES.has(p.text) && prox && prox.x - (p.x + p.w) < 1.3 * p.h && (!cur || p.x - (cur.x + cur.w) > 0.9 * p.h)) {
        if (cur) { out.push(cur); cur = null; }
        out.push({ text: MARCA, x: p.x, y: p.y, w: p.w, h: p.h, conf: p.conf });
        return;
      }
      if (cur && p.x - (cur.x + cur.w) <= 1.5 * Math.max(cur.h, p.h)) {
        const x = Math.min(cur.x, p.x), y = Math.min(cur.y, p.y);
        cur = { text: cur.text + " " + p.text, x, y, w: Math.max(cur.x + cur.w, p.x + p.w) - x, h: Math.max(cur.y + cur.h, p.y + p.h) - y, conf: cur.conf };
      } else { if (cur) out.push(cur); cur = { ...p }; }
    });
    if (cur) out.push(cur);
  }
  return out;
}

// ---------- análise completa ----------
export function analisar(img, segs, escala = 2) {
  let els = segs.map((s) => {
    const e = { kind: "texto", text: s.text, r: { x: s.x, y: s.y, w: s.w, h: s.h }, seg: { x: s.x, y: s.y, w: s.w, h: s.h }, conf: s.conf ?? 1 };
    if (s.text === MARCA) { e.kind = "marcavel"; return e; }
    const en = enclose(img, e.r);
    if (en) {
      const hpt = en.rect.h / escala;
      if (en.aberto) {
        if (en.rect.x < 12) { e.kind = "item"; e.r = en.rect; }
        else if (hpt >= 24 && hpt <= 140) { e.kind = /^[•▸▶►»>]/.test(s.text) ? "acordeao" : "campo"; e.r = en.rect; }
      } else if (hpt >= 24 && hpt <= 70) { e.kind = "botao"; e.r = en.rect; }
      else if (hpt < 24) { e.kind = "etiqueta"; e.r = en.rect; }
    } else if (textoAzul(img, e.r)) e.kind = "link";
    return e;
  });
  const dentro = (r, s) => s.x + s.w / 2 >= r.x && s.x + s.w / 2 <= r.x + r.w && s.y + s.h / 2 >= r.y && s.y + s.h / 2 <= r.y + r.h;
  // caixas que contêm o centro de outros textos são containers
  for (const e of els) {
    if (!["botao", "campo", "etiqueta", "acordeao", "item"].includes(e.kind)) continue;
    if (els.some((o) => o !== e && o.text !== MARCA && dentro(e.r, o.seg))) { e.kind = "texto"; e.r = e.seg; }
  }
  // marcador dentro de uma caixa larga = seta de acordeão
  for (const m of els) {
    if (m.kind !== "marcavel") continue;
    const c = els.find((o) => o.kind === "campo" && dentro(o.r, m.seg));
    if (c) { c.kind = "acordeao"; m.kind = "descartar"; }
  }
  els = els.filter((e) => e.kind !== "descartar");
  const novos = camposPorRotulo(img, els);
  els = els.filter((t) => !(t.kind === "texto" && novos.some((n) => dentro(n.r, t.r))));
  els.push(...novos);
  const cruza = (a, b) => a.x < b.x + b.w + 8 && a.x + a.w + 8 > b.x && a.y < b.y + b.h + 8 && a.y + a.h + 8 > b.y;
  els.push(...marcaveisPorPixel(img, els).filter((m) => !els.some((o) => o.kind === "marcavel" && cruza(o.r, m.r))));
  rotular(els);
  els.sort((a, b) => Math.floor(a.r.y / 40) - Math.floor(b.r.y / 40) || a.r.x - b.r.x);
  return els.map((e, i) => ({
    id: i + 1, kind: e.kind, text: e.text,
    x: Math.floor(e.r.x / escala), y: Math.floor(e.r.y / escala), w: Math.floor(e.r.w / escala), h: Math.floor(e.r.h / escala),
    cx: Math.floor((e.r.x + e.r.w / 2) / escala), cy: Math.floor((e.r.y + e.r.h / 2) / escala),
    fixed: false, hover: false, conf: e.conf ?? 1, rotulo: e.label ?? "", tipo: e.tipo ?? "", obrigatorio: !!e.req,
  }));
}
