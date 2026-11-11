// Cliente mínimo do protocolo Marionette (Firefox) + gerenciador de uma instância invisível com perfil próprio.
// Não toca no Firefox do usuário: --no-remote + perfil temporário + --headless.
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { copiarSessao } from "./sessao.mjs";

// onde está o Firefox em cada sistema (FIREFOX_BIN tem prioridade)
export function acharFirefox() {
  const env = process.env.FIREFOX_BIN;
  if (env && existsSync(env)) return env;
  const cand = process.platform === "darwin"
    ? ["/Applications/Firefox.app/Contents/MacOS/firefox", join(os.homedir(), "Applications/Firefox.app/Contents/MacOS/firefox"), "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox", "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, "Mozilla Firefox", "firefox.exe"))
      : ["/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox", "/usr/bin/firefox-esr", "/opt/firefox/firefox", "/usr/lib/firefox/firefox"];
  const achado = cand.find((c) => existsSync(c));
  if (achado) return achado;
  for (const d of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const n of process.platform === "win32" ? ["firefox.exe"] : ["firefox", "firefox-esr"]) if (d && existsSync(join(d, n))) return join(d, n);
  }
  throw new Error("Firefox não encontrado. Instale o Firefox ou defina FIREFOX_BIN com o caminho do executável.");
}
const portaLivre = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
// tecla de atalho do sistema: Cmd no macOS, Ctrl nos demais
const MOD = process.platform === "darwin" ? "\uE03D" : "\uE009";

export const KEY = { ARROW_RIGHT: "\uE014", ARROW_DOWN: "\uE015", TAB: "", ENTER: "", BACKSPACE: "", DELETE: "", META: "", ESC: "" };

export class Marionette {
  constructor() { this.id = 0; this.pend = new Map(); this.buf = Buffer.alloc(0); this.sock = null; }

  conectar(porta) {
    return new Promise((resolve, reject) => {
      const s = net.connect(porta, "127.0.0.1");
      this.sock = s;
      let hello = false;
      s.on("error", reject);
      s.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
          const i = this.buf.indexOf(0x3a); // ':'
          if (i < 0) return;
          const len = parseInt(this.buf.slice(0, i).toString(), 10);
          if (this.buf.length < i + 1 + len) return;
          const msg = JSON.parse(this.buf.slice(i + 1, i + 1 + len).toString("utf8"));
          this.buf = this.buf.slice(i + 1 + len);
          if (!hello) { hello = true; resolve(msg); continue; }
          const [, id, erro, res] = msg;
          const p = this.pend.get(id);
          if (!p) continue;
          this.pend.delete(id);
          erro ? p.reject(new Error(`${erro.error ?? "erro"}: ${erro.message ?? ""}`)) : p.resolve(res);
        }
      });
    });
  }

  cmd(nome, params = {}) {
    const id = ++this.id;
    const corpo = JSON.stringify([0, id, nome, params]);
    return new Promise((resolve, reject) => {
      this.pend.set(id, { resolve, reject });
      this.sock.write(`${Buffer.byteLength(corpo)}:${corpo}`);
    });
  }

  async iniciar() { await this.cmd("WebDriver:NewSession", { capabilities: {} }); }
  fechar() { try { this.sock?.destroy(); } catch {} }

  async ir(url) { await this.cmd("WebDriver:Navigate", { url }); }
  async url() { return (await this.cmd("WebDriver:GetCurrentURL")).value; }
  async titulo() { return (await this.cmd("WebDriver:GetTitle")).value; }
  async voltar() { await this.cmd("WebDriver:Back"); }
  async recarregar() { await this.cmd("WebDriver:Refresh"); }
  async tamanho(w, h) { await this.cmd("WebDriver:SetWindowRect", { x: 0, y: 0, width: w, height: h }); }
  async rolarPara(y) { return (await this.cmd("WebDriver:ExecuteScript", { script: "window.scrollTo(0, arguments[0]); return window.scrollY;", args: [y] })).value; }
  // cookies de sessão (sem validade) não ficam no disco: entram por aqui, com a aba já no domínio
  async injetarCookies(cookies) {
    let n = 0;
    for (const c of cookies ?? []) {
      try {
        await this.cmd("WebDriver:AddCookie", { cookie: { name: c.name, value: c.value, domain: (c.host ?? "").replace(/^\./, ""), path: c.path ?? "/", secure: !!c.secure, httpOnly: !!c.httponly } });
        n++;
      } catch {}
    }
    return n;
  }
  async estado() {
    const r = await this.cmd("WebDriver:ExecuteScript", { script: "return [location.href, document.readyState];", args: [] });
    return r.value;
  }
  // executa uma sequência (clique, digitação, teclas) numa única chamada: passos = [{c:[x,y]}, {t:"texto"}, {k:[KEY...]}]
  async sequencia(passos) {
    const P = [], K = [];
    const pa = () => ({ type: "pause", duration: 0 });
    for (const p of passos) {
      if (p.c) {
        P.push({ type: "pointerMove", x: Math.round(p.c[0]), y: Math.round(p.c[1]), origin: "viewport", duration: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 });
        K.push(pa(), pa(), pa());
      } else if (p.t !== undefined || p.k) {
        const teclas = p.t !== undefined ? [...p.t] : p.k;
        for (const ch of teclas) { P.push(pa(), pa()); K.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch }); }
      } else if (p.meta) { // Cmd+tecla
        P.push(pa(), pa(), pa(), pa()); K.push({ type: "keyDown", value: MOD }, { type: "keyDown", value: p.meta }, { type: "keyUp", value: p.meta }, { type: "keyUp", value: MOD });
      }
    }
    if (!P.length) return;
    await this.cmd("WebDriver:PerformActions", { actions: [
      { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: P },
      { type: "key", id: "kbd", actions: K }] });
    await this.cmd("WebDriver:ReleaseActions");
  }
  async medidas() {
    const r = await this.cmd("WebDriver:ExecuteScript", { script: "return [innerWidth, innerHeight, document.documentElement.scrollHeight, scrollY, devicePixelRatio];", args: [] });
    return r.value;
  }
  // png em base64; full=true captura a página inteira (sem rolar)
  async print(full = false) { return (await this.cmd("WebDriver:TakeScreenshot", { full, hash: false, scroll: false })).value; }

  async clicar(x, y) {
    await this.cmd("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport", duration: 0 },
      { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
    await this.cmd("WebDriver:ReleaseActions");
  }
  async mover(x, y) {
    await this.cmd("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport", duration: 0 }] }] });
  }
  // digita uma sequência (texto e teclas especiais) numa única chamada
  async digitar(texto) {
    const acoes = [];
    for (const ch of texto) acoes.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
    await this.cmd("WebDriver:PerformActions", { actions: [{ type: "key", id: "kbd", actions: acoes }] });
    await this.cmd("WebDriver:ReleaseActions");
  }
  async selecionarTudoEApagar() {
    await this.cmd("WebDriver:PerformActions", { actions: [{ type: "key", id: "kbd", actions: [
      { type: "keyDown", value: MOD }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: MOD },
      { type: "keyDown", value: KEY.BACKSPACE }, { type: "keyUp", value: KEY.BACKSPACE }] }] });
    await this.cmd("WebDriver:ReleaseActions");
  }
}

// ---- instâncias invisíveis (pool) ----
const procs = new Map();   // porta -> { proc, perfil }
export async function abrirInstancia({ largura = 1280, altura = 1040, dpr = 2, id = 0, sessao = null, perfilDir = null } = {}) {
  const firefox = acharFirefox();
  const porta = await portaLivre();
  const perfil = perfilDir ?? mkdtempSync(join(os.tmpdir(), `firefox-qa-${id}-`));
  if (perfilDir) mkdirSync(perfilDir, { recursive: true });
  writeFileSync(join(perfil, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("startup.homepage_welcome_url", "about:blank");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    `user_pref("layout.css.devPixelsPerPx", "${dpr}");`,
    `user_pref("marionette.port", ${porta});`,
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("ui.prefersReducedMotion", 1);',
    'user_pref("ui.useOverlayScrollbars", 0);',
    'user_pref("general.smoothScroll", false);',
    'user_pref("browser.tabs.animate", false);',
  ].join("\n"));
  let copia = null;
  if (sessao?.perfilOrigem) { try { copia = copiarSessao(sessao.perfilOrigem, perfil, sessao.url); } catch (e) { copia = { erro: e.message, sessao: [] }; } }
  const proc = spawn(firefox, ["--headless", "--marionette", "--no-remote", "--profile", perfil, "--width", String(largura), "--height", String(altura), "about:blank"], { stdio: "ignore", windowsHide: true });
  procs.set(porta, { proc, perfil, manter: !!perfilDir });
  proc.on("exit", () => { procs.delete(porta); if (!perfilDir) try { rmSync(perfil, { recursive: true, force: true }); } catch {} });
  const m = new Marionette();
  m.porta = porta; m.copiaSessao = copia;
  let ult;
  for (let i = 0; i < 100; i++) {
    try { await m.conectar(porta); ult = null; break; } catch (e) { ult = e; await new Promise((r) => setTimeout(r, 200)); m.sock?.destroy(); m.buf = Buffer.alloc(0); }
  }
  if (ult) { fecharInstancia(m); throw new Error("o Firefox invisível não respondeu (Marionette): " + ult.message); }
  await m.iniciar();
  await m.tamanho(largura, altura);
  return m;
}
export function fecharInstancia(m) {
  if (!m) return;
  try { m.cmd("Marionette:Quit", {}).catch(() => {}); } catch {}
  m.fechar();
  const p = procs.get(m.porta);
  try { p?.proc.kill(); } catch {}
}
// nunca deixa Firefox invisível órfão quando o processo do MCP termina
export function fecharTudo() { for (const { proc, perfil, manter } of procs.values()) { try { proc.kill(); } catch {} if (!manter) try { rmSync(perfil, { recursive: true, force: true }); } catch {} } procs.clear(); }
process.on("exit", fecharTudo);
for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => { fecharTudo(); process.exit(0); });
