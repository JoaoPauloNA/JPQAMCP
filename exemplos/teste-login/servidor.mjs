// Site de teste com login (cookie persistente + cookie de sessão + localStorage), só para validar a cópia de sessão.
// node servidor.mjs [porta]  ->  /login (formulário), /app (exige login), /sair
import http from "node:http";
const PORTA = Number(process.argv[2] ?? 8791);
const pagina = (titulo, corpo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title>
<style>body{font:16px system-ui;margin:40px;max-width:480px}input,button{font:inherit;padding:8px;margin:6px 0;width:100%;box-sizing:border-box}button{background:#2563eb;color:#fff;border:0;border-radius:6px}</style></head><body>${corpo}</body></html>`;

http.createServer((req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=")));
  const logado = cookies.sid === "sessao-valida";
  if (req.url === "/login" && req.method === "POST") {
    res.writeHead(302, { Location: "/app", "Set-Cookie": ["sid=sessao-valida; Path=/; Max-Age=3600; HttpOnly", "lembrar=1; Path=/"] }); return res.end();
  }
  if (req.url === "/sair") { res.writeHead(302, { Location: "/login", "Set-Cookie": ["sid=; Path=/; Max-Age=0"] }); return res.end(); }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url.startsWith("/app")) {
    if (!logado) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    return res.end(pagina("Painel — área logada", `<h1>Painel do cliente</h1><p>Você está logado como Maria.</p><button id="acao" onclick="document.getElementById('msg').textContent='Ação executada.'">Executar ação</button><p id="msg"></p>`));
  }
  res.end(pagina("Entrar", `<h1>Entrar</h1><form method="post" action="/login"><input name="email" placeholder="E-mail"><input name="senha" type="password" placeholder="Senha"><button>Entrar</button></form>`));
}).listen(PORTA, "127.0.0.1", () => console.log(`pronto http://127.0.0.1:${PORTA}`));
