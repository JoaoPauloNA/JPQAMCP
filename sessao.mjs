// Sessão do Firefox do usuário: lista as abas abertas, acha a certa e copia a sessão (cookies e storage do site) para
// perfis temporários. Tudo local; nada é impresso ou enviado: só host e contagens aparecem nos logs.
import { readFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// ---------- mozlz4 (formato do sessionstore) ----------
function lz4(src, tam) {
  const dst = Buffer.alloc(tam); let s = 0, d = 0;
  while (s < src.length) {
    const tok = src[s++]; let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(dst, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = tok & 15; if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4; let de = d - off;
    for (let i = 0; i < ml; i++) dst[d++] = dst[de++];
  }
  return dst.subarray(0, d);
}
export function lerMozlz4(arq) {
  const b = readFileSync(arq);
  if (b.toString("latin1", 0, 7) !== "mozLz40") throw new Error("arquivo de sessão em formato desconhecido");
  return lz4(b.subarray(12), b.readUInt32LE(8));
}

// ---------- perfis ----------
function raizes() {
  const h = os.homedir();
  if (process.platform === "darwin") return [join(h, "Library/Application Support/Firefox/Profiles")];
  if (process.platform === "win32") return [join(process.env.APPDATA ?? join(h, "AppData/Roaming"), "Mozilla/Firefox/Profiles")];
  return [join(h, ".mozilla/firefox"), join(h, "snap/firefox/common/.mozilla/firefox"), join(h, ".var/app/org.mozilla.firefox/.mozilla/firefox")];
}
const ARQ_SESSAO = ["sessionstore-backups/recovery.jsonlz4", "sessionstore-backups/previous.jsonlz4", "sessionstore.jsonlz4"];
const arqSessao = (p) => ARQ_SESSAO.map((a) => join(p, a)).find((a) => existsSync(a));

// perfil em uso: o de sessão gravada mais recentemente (o Firefox regrava a cada ~15 s)
export function perfilAtivo() {
  perfilAtivo.erro = null;
  perfilAtivo.codigoErro = null;
  const falha = (e) => {
    perfilAtivo.codigoErro = e.code ?? "PERFIL_INDISPONIVEL";
    perfilAtivo.erro = ["EPERM", "EACCES"].includes(e.code)
      ? "Acesso ao perfil do Firefox negado pelo sistema. Autorize a leitura para o aplicativo que inicia o MCP nas configurações de privacidade do sistema e reinicie esse aplicativo. FIREFOX_PROFILE apenas seleciona um perfil; não concede permissão."
      : `Não foi possível acessar o perfil do Firefox: ${e.message}`;
  };
  if (process.env.FIREFOX_PROFILE) {
    try {
      const p = process.env.FIREFOX_PROFILE;
      if (!statSync(p).isDirectory()) throw Object.assign(new Error("FIREFOX_PROFILE deve apontar para uma pasta"), { code: "ENOTDIR" });
      readdirSync(p); // confirma o acesso, sem confiar em existsSync (que oculta EPERM)
      return p;
    } catch (e) { falha(e); return null; }
  }
  let melhor = null, t = 0;
  for (const r of raizes()) {
    try {
      for (const d of readdirSync(r)) {
        const p = join(r, d); const a = existsSync(join(p, "prefs.js")) && arqSessao(p);
        if (a && statSync(a).mtimeMs > t) { t = statSync(a).mtimeMs; melhor = p; }
      }
    } catch (e) { if (e.code !== "ENOENT") falha(e); }
  }
  if (melhor) { perfilAtivo.erro = null; perfilAtivo.codigoErro = null; }
  return melhor;
}

// ---------- abas ----------
function sessaoJSON(perfil) { const a = arqSessao(perfil); if (!a) throw new Error("não encontrei a sessão do Firefox (o Firefox está aberto?)"); return JSON.parse(lerMozlz4(a).toString("utf8")); }

export function abasAbertas(perfil) {
  const j = sessaoJSON(perfil); const out = [];
  (j.windows ?? []).forEach((w, wi) => (w.tabs ?? []).forEach((t, ti) => {
    const e = t.entries?.[(t.index || t.entries.length) - 1]; if (!e?.url) return;
    out.push({ janela: wi, aba: ti, url: e.url, titulo: e.title ?? "", ativa: (w.selected ?? 1) - 1 === ti, janelaAtiva: wi === (j.selectedWindow ?? 1) - 1 });
  }));
  return out;
}

const limpa = (u) => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return String(u).split("#")[0].replace(/\/$/, ""); } };
// acha a aba certa: URL igual > mesmo caminho > mesmo site; sem URL, a aba ativa da janela ativa. `trecho` filtra por título/URL.
export function localizarAba(abas, { url, trecho } = {}) {
  let c = abas.filter((a) => !/^(about|moz-extension|chrome):/.test(a.url));
  if (trecho) { const t = trecho.toLowerCase(); c = c.filter((a) => a.titulo.toLowerCase().includes(t) || a.url.toLowerCase().includes(t)); }
  if (!url) return { aba: c.find((a) => a.ativa && a.janelaAtiva) ?? c.find((a) => a.ativa) ?? c[0] ?? null, motivo: trecho ? "filtro por título/URL" : "aba ativa", candidatas: c.length };
  const alvo = limpa(url); let u; try { u = new URL(alvo); } catch { u = null; }
  const por = (f) => c.filter(f).sort((a, b) => (b.ativa - a.ativa) || (b.janelaAtiva - a.janelaAtiva));
  const igual = por((a) => limpa(a.url) === alvo);
  if (igual[0]) return { aba: igual[0], motivo: "mesma URL", candidatas: igual.length };
  const caminho = u && por((a) => { try { const x = new URL(a.url); return x.origin === u.origin && x.pathname === u.pathname; } catch { return false; } });
  if (caminho?.[0]) return { aba: caminho[0], motivo: "mesmo caminho", candidatas: caminho.length };
  const site = u && por((a) => { try { return new URL(a.url).origin === u.origin; } catch { return false; } });
  if (site?.[0]) return { aba: site[0], motivo: "mesmo site", candidatas: site.length };
  return { aba: null, motivo: "nenhuma aba aberta com esse endereço", candidatas: 0 };
}

// ---------- cópia da sessão ----------
const hostDe = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const registrável = (h) => h.split(".").slice(-2).join(".");   // exemplo.com para app.exemplo.com

// cookies persistentes e storage do site vão como arquivos; cookies de sessão (sem validade) saem do sessionstore
export function copiarSessao(perfilOrigem, perfilDestino, url) {
  const host = hostDe(url); if (!host) return { host: "", cookies: 0, storage: 0, sessao: [] };
  const r = { host, cookies: 0, storage: 0, sessao: [] };
  for (const f of ["cookies.sqlite", "cookies.sqlite-wal", "cookies.sqlite-shm"]) {
    const o = join(perfilOrigem, f); if (existsSync(o)) { copyFileSync(o, join(perfilDestino, f)); if (f === "cookies.sqlite") r.cookies = 1; }
  }
  const base = join(perfilOrigem, "storage", "default");
  if (existsSync(base)) {
    const reg = registrável(host);
    for (const d of readdirSync(base)) {
      if (!d.includes(reg)) continue;                      // só os origens do mesmo site
      mkdirSync(join(perfilDestino, "storage", "default"), { recursive: true });
      cpSync(join(base, d), join(perfilDestino, "storage", "default", d), { recursive: true }); r.storage++;
    }
  }
  try {
    const j = sessaoJSON(perfilOrigem); const reg = registrável(host);
    for (const w of j.windows ?? []) for (const c of w.cookies ?? []) if ((c.host ?? "").replace(/^\./, "").endsWith(reg)) r.sessao.push(c);
  } catch {}
  return r;
}

export function resumo(a) { return a ? { janela: a.janela + 1, aba: a.aba + 1, titulo: a.titulo, url: a.url } : null; }
