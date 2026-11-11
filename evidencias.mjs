import { isAbsolute, relative, sep } from 'node:path';

// Somente caminhos de artefatos dentro da pasta do relatório são relativizados.
export function portatil(valor, dir) {
  const caminho = (s) => {
    if (!isAbsolute(s)) return s;
    const r = relative(dir, s);
    return r === '' ? '.' : r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) ? r.split(sep).join('/') : s;
  };
  if (typeof valor === 'string') return caminho(valor);
  if (Array.isArray(valor)) return valor.map((v) => portatil(v, dir));
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [caminho(k), portatil(v, dir)]));
  return valor;
}

export function cobertura(telas, pendentes, modo, maxTelas) {
  return {
    modo, limiteTelas: maxTelas, telasTestadas: telas.length,
    telasNaoVisitadas: [...pendentes],
    botoesTestados: telas.reduce((n, t) => n + t.botoes.length, 0),
    inconclusivos: telas.reduce((n, t) => n + t.botoes.filter((b) => !b.real).length, 0),
    porTela: telas.map((t) => {
      const ids = new Set(t.botoes.map((b) => b.elemento.id));
      const F = t.form;
      if (F?.cenarios.A || F?.cenarios.B?.enviar) ids.add(F.enviar?.id);
      if (F?.cenarios.limpar) ids.add(F.limpar?.id);
      return {
        url: t.url, titulo: t.titulo,
        formularioIdentificado: !!F,
        cenariosExecutados: Object.keys(F?.cenarios ?? {}),
        cenariosNaoExecutados: F ? ['A', 'B', 'C', 'limpar'].filter((k) => !F.cenarios[k]) : [],
        controlesNaoTestados: t.elementos.filter((e) => ['botao', 'item', 'link', 'acordeao'].includes(e.kind) && !ids.has(e.id)).map((e) => ({ id: e.id, texto: e.text, motivo: 'Não executado nesta rodada (filtro, modo ou descoberta tardia).' })),
        camposNaoSuportados: (F?.naoSuportados ?? []).map((c) => ({ rotulo: c.rotulo, tipo: c.tipo })),
        zoomParcial: !!(t.zoom?.parcial || t.zoom?.erro),
      };
    }),
    limites: ['Não valida regras de negócio sem requisitos esperados.', 'Não valida backend, persistência, segurança ou acessibilidade.', 'Ausência de mudança visual é inconclusiva; não comprova defeito.'],
  };
}
