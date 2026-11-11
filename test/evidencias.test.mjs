import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cobertura, portatil } from '../evidencias.mjs';
import { relatorioQA } from '../report.mjs';

test('cobertura distingue cliques, cenários, controles ignorados e limite de telas', () => {
 const c = cobertura([{ url:'https://example.test', titulo:'Teste', elementos:[{id:1,kind:'botao',text:'A'},{id:2,kind:'botao',text:'B'},{id:3,kind:'botao',text:'Enviar'}], botoes:[{elemento:{id:1},real:false}], form:{enviar:{id:3},cenarios:{A:{}},naoSuportados:[{rotulo:'Mês',tipo:'mes'}]},zoom:{parcial:true} }], new Set(['https://example.test/2']), 'rapido', 1);
 assert.equal(c.inconclusivos,1);
 assert.deepEqual(c.porTela[0].controlesNaoTestados.map(e=>e.id),[2]);
 assert.deepEqual(c.porTela[0].cenariosNaoExecutados,['B','C','limpar']);
 assert.equal(c.telasNaoVisitadas.length,1);
 assert.equal(c.porTela[0].camposNaoSuportados[0].tipo,'mes');
 assert(c.porTela[0].zoomParcial);
});

test('não anuncia cenários de formulário em tela sem formulário', () => {
 const c=cobertura([{url:'x',elementos:[],botoes:[]}],[], 'completo',5);
 assert.deepEqual(c.porTela[0].cenariosNaoExecutados,[]);
});

test('artefatos continuam legíveis após mover pasta e remover origem', () => {
 const raiz=mkdtempSync(join(tmpdir(),'qa-origem-'));
 const destino=mkdtempSync(join(tmpdir(),'qa-destino-'));
 try {
  writeFileSync(join(raiz,'imagem.png'),Buffer.from('imagem-de-teste'));
  const c=cobertura([],[], 'completo',5);
  const r=portatil({dir:raiz,urlInicial:'https://example.test',hora:'12:00',totalMs:5400,telas:[],fases:{},mini:{[join(raiz,'imagem.png')]:join(raiz,'imagem.png')},cobertura:c,bugs:[{titulo:'Sem reação',status:'inconclusivo',evidencias:[join(raiz,'imagem.png')],reproducao:{passos:['Clicar em <teste>']}}]},raiz);
  assert.equal(r.dir,'.');
  assert.equal(r.bugs[0].evidencias[0],'imagem.png');
  assert.equal(r.urlInicial,'https://example.test');
  cpSync(raiz,destino,{recursive:true}); rmSync(raiz,{recursive:true});
  r.dir=destino;
  const html=readFileSync(relatorioQA(r),'utf8');
  assert(html.includes(Buffer.from('imagem-de-teste').toString('base64')));
  assert(html.includes('Cobertura desta execução'));
  assert(html.includes('inconclusivo'));
  assert(html.includes('&lt;teste&gt;'));
  assert(!html.includes('meta de 5 s'));
 } finally {rmSync(raiz,{recursive:true,force:true});rmSync(destino,{recursive:true,force:true});}
});

test('falha real do MCP aparece no HTML sem aviso de meta de tempo', () => {
 const dir=mkdtempSync(join(tmpdir(),'qa-erro-'));
 try {
  const base={dir,urlInicial:'http://localhost',hora:'12:00',totalMs:5100,telas:[],bugs:[],sessaoInfo:{usada:false,erro:{codigo:'EPERM',mensagem:'Leitura negada'}}};
  const html=readFileSync(relatorioQA(base),'utf8');
  assert(html.includes('Erro do MCP [EPERM]'));
  assert(html.includes('Leitura negada'));
  assert(!html.includes('meta de 5 s'));
  base.sessaoInfo={usada:false,aviso:'nenhuma aba correspondente'};
  assert(!readFileSync(relatorioQA(base),'utf8').includes('Erro do MCP'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
