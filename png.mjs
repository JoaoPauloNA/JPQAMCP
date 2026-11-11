// PNG em JS puro (sem dependências): leitura RGBA 8 bits, escrita (cinza ou RGBA) e redução. Usado no backend portátil.
import zlib from "node:zlib";

const ASSINATURA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function lerPNG(buf) {
  if (!buf.subarray(0, 8).equals(ASSINATURA)) throw new Error("não é PNG");
  let p = 8, w = 0, h = 0, tipoCor = 6, bits = 8, entrelacado = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), tipo = buf.toString("ascii", p + 4, p + 8);
    if (tipo === "IHDR") { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); bits = buf[p + 16]; tipoCor = buf[p + 17]; entrelacado = buf[p + 20]; }
    else if (tipo === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    else if (tipo === "IEND") break;
    p += 12 + len;
  }
  if (bits !== 8 || entrelacado !== 0 || (tipoCor !== 6 && tipoCor !== 2)) throw new Error(`PNG não suportado (bits ${bits}, cor ${tipoCor})`);
  const bpp = tipoCor === 6 ? 4 : 3, linha = w * bpp;
  const cru = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = cru[y * (linha + 1)], src = y * (linha + 1) + 1, dst = y * linha, ant = dst - linha;
    if (f === 0) { px.set(cru.subarray(src, src + linha), dst); }
    else if (f === 1) { for (let i = 0; i < linha; i++) px[dst + i] = (cru[src + i] + (i >= bpp ? px[dst + i - bpp] : 0)) & 255; }
    else if (f === 2) { for (let i = 0; i < linha; i++) px[dst + i] = (cru[src + i] + (y ? px[ant + i] : 0)) & 255; }
    else if (f === 3) { for (let i = 0; i < linha; i++) px[dst + i] = (cru[src + i] + (((i >= bpp ? px[dst + i - bpp] : 0) + (y ? px[ant + i] : 0)) >> 1)) & 255; }
    else {
      for (let i = 0; i < linha; i++) {
        const a = i >= bpp ? px[dst + i - bpp] : 0, b = y ? px[ant + i] : 0, c = i >= bpp && y ? px[ant + i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        px[dst + i] = (cru[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
  }
  if (bpp === 4) return { w, h, d: px };
  const d = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { d[j] = px[i]; d[j + 1] = px[i + 1]; d[j + 2] = px[i + 2]; d[j + 3] = 255; }
  return { w, h, d };
}

const TABELA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pedaco(tipo, dados) {
  const b = Buffer.alloc(12 + dados.length);
  b.writeUInt32BE(dados.length, 0); b.write(tipo, 4, "ascii"); dados.copy(b, 8);
  b.writeUInt32BE(crc(b.subarray(4, 8 + dados.length)), 8 + dados.length);
  return b;
}
// canais: 1 (cinza) ou 4 (RGBA)
export function gravarPNG(w, h, dados, canais = 4) {
  const linha = w * canais, cru = Buffer.alloc((linha + 1) * h);
  for (let y = 0; y < h; y++) { cru[y * (linha + 1)] = 0; cru.set(dados.subarray(y * linha, (y + 1) * linha), y * (linha + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = canais === 1 ? 0 : 6;
  return Buffer.concat([ASSINATURA, pedaco("IHDR", ihdr), pedaco("IDAT", zlib.deflateSync(cru, { level: 1 })), pedaco("IEND", Buffer.alloc(0))]);
}

// redução por média de blocos (fator inteiro) para miniaturas
export function reduzir(img, larguraMax) {
  const f = Math.max(1, Math.ceil(img.w / larguraMax));
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f), d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let yy = 0; yy < f; yy++) { let i = ((y * f + yy) * img.w + x * f) * 4; for (let xx = 0; xx < f; xx++, i += 4) { r += img.d[i]; g += img.d[i + 1]; b += img.d[i + 2]; } }
    const j = (y * w + x) * 4, n = f * f; d[j] = r / n; d[j + 1] = g / n; d[j + 2] = b / n; d[j + 3] = 255;
  }
  return { w, h, d };
}
