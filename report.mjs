// Relatório HTML do QA completo (qa.mjs): bugs por hora, telas, botões, formulário e linha do tempo.
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let MINI = {}, BASE = ".";
const b64 = (f) => { const m = MINI[f]; if (!m) return ""; try { return `data:image/${m.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(isAbsolute(m) ? m : join(BASE, m)).toString("base64")}`; } catch { return ""; } };
// ================= relatório do QA completo (qa.mjs) =================
const th = (f, leg) => f ? `<figure><img src="${b64(f)}"><figcaption>${esc(leg)}</figcaption></figure>` : "";
const ZOOM_X = 3;
const sevCls = { alta: "bad", média: "warn", baixa: "mute" };

export function relatorioQA(res) {
  MINI = res.mini ?? {}; BASE = res.dir;
  const todosBotoes = res.telas.flatMap((t) => t.botoes);
  const forms = res.telas.filter((t) => t.form?.enviar);
  const camposTot = res.telas.reduce((n, t) => n + (t.form?.campos?.length ?? 0), 0);
  const veredito = { reagiu: ["ok", "Reagiu"], navegou: ["ok", "Navegou"], sem_reacao: ["warn", "Sem reação visível"] };

  const si = res.sessaoInfo;
  const avisosHtml = [
    si && (si.usada
      ? `<div class="aviso ok">Sessão do seu Firefox usada: aba “${esc(si.aba.titulo)}” (janela ${si.aba.janela}, aba ${si.aba.aba}; ${esc(si.motivo)}). Cookies e dados do site foram copiados para instâncias temporárias, que são apagadas ao fim. Nenhum valor é gravado no relatório.</div>`
      : ""),
    ...(res.avisos ?? []).map((a) => `<div class="aviso">⚠ ${esc(a)}</div>`),
  ].filter(Boolean).join("");
  const eventos = [];
  for (const t of res.telas) {
    for (const b of t.botoes) eventos.push([b.hora, `Clique em “${b.elemento.text}” (${t.titulo}) → ${b.veredito}`, `${b.reagirMs} ms`]);
    const F = t.form; if (!F) continue;
    const c = F.cenarios;
    if (c.A) eventos.push([c.A.hora, `Formulário: envio vazio (${t.titulo})`, `${c.A.ms} ms`]);
    if (c.B) { eventos.push([c.B.hora, `Formulário: preenchimento rápido de ${c.B.campos} controles`, `${c.B.preencherMs} ms`]); if (c.B.enviar) eventos.push([c.B.enviar.hora, "Formulário: envio com dados válidos", `${c.B.enviar.ms} ms`]); }
    if (c.C) eventos.push([c.C.hora, "Formulário: envio com valores inválidos", `${c.C.ms} ms`]);
    if (c.limpar) eventos.push([c.limpar.hora, "Formulário: botão Limpar", `${c.limpar.ms} ms`]);
  }
  eventos.sort((a, b) => a[0].localeCompare(b[0]));

  const bugsHtml = res.bugs.length
    ? `<table><thead><tr><th>Hora</th><th>Gravidade</th><th>Tela</th><th>Achado</th><th>Detalhe</th></tr></thead><tbody>${res.bugs.map((b) => `<tr><td>${esc(b.hora)}</td><td><span class="tag ${sevCls[b.sev] ?? "mute"}">${b.sev}</span></td><td>${esc(b.tela)}</td><td>${esc(b.titulo)}<br><span class="tag warn">${esc(b.status ?? "suspeita")}</span></td><td>${esc(b.detalhe)}<br><b>Esperado:</b> ${esc(b.esperado)}<br><b>Reprodução:</b> ${esc(b.reproducao?.url)}<br>${(b.reproducao?.passos ?? []).map(esc).join("<br>")}<br>${(b.reproducao?.dadosTeste ?? []).map((d) => `${esc(d.campo)}: ${esc(d.valor)}`).join("; ")}<div class="thumbs">${(b.evidencias ?? []).map((f, i) => th(f, `evidência ${i + 1}`)).join("")}</div></td></tr>`).join("")}</tbody></table>`
    : "<p>Nenhuma suspeita localizada nos cenários executados.</p>";

  const telasHtml = res.telas.map((t, i) => {
    const linhas = t.botoes.map((b) => {
      const [cls, rot] = veredito[b.veredito] ?? ["mute", b.veredito];
      return `<tr><td>${esc(b.hora)}</td><td><b>${esc(b.elemento.text)}</b><br><small>${esc(b.elemento.kind)} · centro (${b.elemento.cx}, ${b.elemento.cy})</small></td>
        <td><span class="tag ${cls}">${rot}</span>${b.navegou ? `<br><small>→ ${esc(decodeURI(b.urlDepois))}</small>` : ""}</td>
        <td>${b.reagirMs} ms<small><br>ciclo ${b.cicloMs} ms</small></td>
        <td>${(b.textosNovos ?? []).slice(0, 6).map(esc).join("<br>")}${(b.notas ?? []).map((n) => `<br><small class="warn-t">${esc(n)}</small>`).join("")}</td>
        <td><div class="thumbs">${th(b.arqAntes, "antes")}${th(b.arqDepois, "depois")}</div></td></tr>`;
    }).join("");
    let formHtml = "";
    const F = t.form;
    if (F?.resultados) {
      const R = F.resultados;
      const obr = new Map(R.obrigatorios.map((o) => [o.campo.id, o])), inv = new Map(R.invalidos.map((o) => [o.campo.id, o]));
      const sim = (v) => v === null || v === undefined ? "—" : v ? "✓" : "✗";
      const linhasC = R.campos.map((c) => {
        const o = obr.get(c.campo.id), v = inv.get(c.campo.id);
        return `<tr><td>${esc(c.campo.rotulo || "(sem rótulo)")}${c.campo.obrigatorio ? " *" : ""}</td><td>${esc(c.campo.tipo)}</td><td>${c.suportado ? esc(c.esperado) : "<small>tipo não suportado</small>"}</td><td>${esc(c.lido)}</td><td>${sim(c.aceitou)}</td><td>${sim(c.mascaraOk)}</td><td>${o ? sim(o.ok) : "—"}</td><td>${v ? sim(v.ok) : "—"}</td></tr>`;
      }).join("");
      const C = F.cenarios;
      formHtml = `<h3>Formulário</h3>
        <p><small>Cenários: <b>A</b> envio vazio (${C.A?.hora ?? "—"}) · <b>B</b> preenchimento rápido de ${C.B?.campos ?? 0} controles em <b>${C.B?.preencherMs ?? "—"} ms</b> e envio (${C.B?.hora ?? "—"}) · <b>C</b> valores inválidos (${C.C?.hora ?? "—"}) · <b>D</b> botão Limpar${C.limpar ? ` (${C.limpar.igualVazio ? "voltou ao início" : "não voltou ao início"})` : " (não encontrado)"}.</small></p>
        <p>Resultado do envio válido: <span class="tag ${R.envio.sucesso ? "ok" : "bad"}">${R.envio.sucesso ? "confirmação exibida" : "sem confirmação"}</span>${R.envio.erros.length ? ` <small>${R.envio.erros.map(esc).join(" · ")}</small>` : ""}</p>
        <table><thead><tr><th>Campo</th><th>Tipo</th><th>Esperado</th><th>Lido na tela</th><th>Aceitou</th><th>Máscara</th><th>Obrigatório avisa</th><th>Inválido avisa</th></tr></thead><tbody>${linhasC}</tbody></table>
        ${F.naoSuportados.length ? `<p><small>Não testados (tipo ainda não suportado): ${F.naoSuportados.map((c) => esc(c.rotulo)).join(", ")}.</small></p>` : ""}
        <div class="thumbs">${th(F.shots.A, "A · envio vazio")}${th(F.shots.B_pre, "B · preenchido")}${th(F.shots.B_env, "B · enviado")}${th(F.shots.C_env, "C · inválidos")}</div>`;
    } else if (F?.isolado) {
      formHtml = `<h3>Campos</h3><table><thead><tr><th>Hora</th><th>Campo</th><th>Resultado</th><th>Antes / depois</th></tr></thead><tbody>${F.isolado.map((s) => `<tr><td>${s.hora}</td><td>${esc(s.campo.rotulo || s.campo.text)}</td><td>${s.mudou ? "reagiu" : "sem mudança"}<br><small>${(s.textosNovos ?? []).map(esc).join("<br>")}</small></td><td><div class="thumbs">${th(s.arqAntes, "antes")}${th(s.arqDepois, "depois")}</div></td></tr>`).join("")}</tbody></table>`;
    }
    const Z = t.zoom;
    const zoomHtml = Z && Z.candidatos !== undefined ? `<p><small>Zoom ${ZOOM_X}x: ${Z.regioes} região(ões) refeita(s) em ${Z.ms} ms a partir de ${Z.candidatos} ponto(s) de leitura duvidosa${Z.parcial ? " (parcial: o tempo acabou)" : ""}.${Z.corrigidos?.length ? ` Leituras corrigidas: ${Z.corrigidos.map((c) => `“${esc(c.de)}” → “${esc(c.para)}”`).join("; ")}.` : ""}${Z.novos?.length ? ` Elementos que só apareceram com o zoom: ${Z.novos.map((n) => `“${esc(n.text)}” (x=${n.x}, y=${n.y})`).join("; ")}.` : ""}</small></p>` : Z?.erro ? `<p><small>Zoom indisponível: ${esc(Z.erro)}</small></p>` : "";
    return `<h2>Tela ${i + 1}: ${esc(t.titulo)}</h2><p><small>${esc(decodeURI(t.url))} · ${t.pagina.w}×${t.pagina.h} px · ${t.elementos.length} elementos · mapeada em ${t.mapearMs} ms</small></p>${zoomHtml}
      <div class="card map"><img src="${b64(join(t.dir, "pagina.png"))}" alt="tela"></div>
      <h3>Botões e itens clicáveis (${t.botoes.length})</h3><div class="card">${t.botoes.length ? `<table><thead><tr><th>Hora</th><th>Botão</th><th>Resultado</th><th>Tempo</th><th>O que apareceu</th><th>Antes / depois</th></tr></thead><tbody>${linhas}</tbody></table>` : "<p>Nenhum.</p>"}</div>
      <div class="card" style="margin-top:12px">${formHtml || "<p>Sem formulário nesta tela.</p>"}</div>`;
  }).join("");

  const C = res.cobertura;
  const coberturaHtml = C ? `<h2>Cobertura desta execução</h2><div class="card"><p>${C.telasTestadas} telas · ${C.botoesTestados} controles clicados · ${C.inconclusivos} cliques inconclusivos · limite de ${C.limiteTelas} telas.</p>
    <p>Telas descobertas não visitadas: ${C.telasNaoVisitadas.map(esc).join(", ") || "nenhuma"}.</p>
    ${C.porTela.map((t) => `<p><b>${esc(t.titulo)}</b>: cenários executados ${t.cenariosExecutados.map(esc).join(", ") || "nenhum"}; não executados ${t.cenariosNaoExecutados.map(esc).join(", ") || "nenhum"}. Controles não testados: ${t.controlesNaoTestados.map((e) => esc(e.texto || e.id)).join(", ") || "nenhum"}. Campos não suportados: ${t.camposNaoSuportados.map((e) => esc(e.rotulo || e.tipo)).join(", ") || "nenhum"}.${t.zoomParcial ? " Zoom incompleto." : ""}</p>`).join("")}
    <p>A: envio vazio · B: preenchimento e envio · C: valores inválidos · limpar: restauração do formulário.</p><ul>${C.limites.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";
  const fases = res.fases ?? {};
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de QA — ${esc(res.hora)}</title>
<style>
:root{--bg:#f4f6fa;--card:#fff;--tx:#1f2937;--mu:#6b7280;--bd:#e3e7ef;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0f1220;--card:#181c30;--tx:#e8eaf6;--mu:#9aa1c4;--bd:#2c3354}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}h2{margin:32px 0 6px}h3{margin:18px 0 8px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px 18px;overflow:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpis .card b{display:block;font-size:1.5rem}.kpis span{color:var(--mu);font-size:.8rem}
table{width:100%;border-collapse:collapse}th,td{padding:7px 9px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}th{color:var(--mu);font-size:.72rem;text-transform:uppercase}
.tag{padding:2px 9px;border-radius:99px;font-size:.75rem;font-weight:600;display:inline-block}.ok{background:#dcfce7;color:#166534}.warn{background:#fef3c7;color:#92400e}.bad{background:#fee2e2;color:#991b1b}.mute{background:#e5e7eb;color:#374151}
.aviso{background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:10px;padding:10px 14px;margin:12px 0}.aviso.ok{background:#dcfce7;color:#166534;border-color:#86efac}.warn-t{color:var(--warn)}small{color:var(--mu)}.map img{width:100%;max-width:760px;height:auto;border-radius:6px;display:block;margin:auto}
.thumbs{display:flex;gap:6px;flex-wrap:wrap}.thumbs img{width:170px;border:1px solid var(--bd);border-radius:4px}figure{margin:0}figcaption{font-size:.7rem;color:var(--mu)}
</style></head><body><main>
<h1>Relatório de QA — modo usuário (blackbox)</h1>
<p><small>Gerado às ${esc(res.hora)} · motor de imagem: ${esc(res.backend ?? "")} · sistema: ${esc(res.sistema ?? "")} · ponto de partida ${esc(decodeURI(res.urlInicial))} · somente telas (pixels) e cliques/digitação reais num Firefox invisível, sem acesso ao código</small></p>
${avisosHtml}
<div class="kpis">
<div class="card"><b>${(res.totalMs / 1000).toFixed(1)} s</b><span>tempo do teste completo</span></div>
<div class="card"><b>${res.telas.length}</b><span>telas exploradas</span></div>
<div class="card"><b>${todosBotoes.length}</b><span>botões/itens clicados</span></div>
<div class="card"><b>${camposTot}</b><span>campos identificados</span></div>
<div class="card"><b>${forms.length}</b><span>formulários com envio identificado</span></div>
<div class="card"><b>${res.bugs.length}</b><span>achados para revisão</span></div>
</div>
${coberturaHtml}
<h2>Achados para revisão (por hora)</h2><div class="card">${bugsHtml}</div>
${telasHtml}
<h2>Linha do tempo</h2><div class="card"><table><thead><tr><th>Hora</th><th>Ação</th><th>Duração</th></tr></thead><tbody>${eventos.map((e) => `<tr><td>${esc(e[0])}</td><td>${esc(e[1])}</td><td>${esc(e[2])}</td></tr>`).join("")}</tbody></table></div>
<h2>Tempos</h2><div class="card"><p><small>Instâncias do Firefox já abertas (aquecimento: ${fases.aquecimentoMs ?? 0} ms, só na primeira execução). Fases em ms desde o início: ${Object.entries(fases).filter(([k]) => k !== "trace" && k !== "aquecimentoMs").map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}.</small></p></div>
<h2>Limitações</h2><div class="card"><ul>
<li>Elementos são reconhecidos por OCR e análise de pixels: texto muito pequeno ou sem contraste pode não ser lido.</li>
<li>O teste roda num viewport do tamanho da página inteira, então rolagem e elementos fixos não são exercitados.</li>
<li>Selects, datas e opções marcáveis são preenchidos por teclado; datas/horas combinadas, mês e semana ainda não são testados.</li>
<li>O QA não abre a sua janela do Firefox: ele navega no mesmo endereço numa instância invisível e separada.</li>
</ul></div></main></body></html>`;
  const out = join(res.dir, "relatorio.html");
  writeFileSync(out, html);
  return out;
}
