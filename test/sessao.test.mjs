import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { perfilAtivo } from '../sessao.mjs';

test('perfil explícito inválido gera erro e diagnóstico é limpo após recuperação', () => {
 const anterior=process.env.FIREFOX_PROFILE;
 const dir=mkdtempSync(join(tmpdir(),'qa-perfil-'));
 try {
  process.env.FIREFOX_PROFILE=join(dir,'inexistente');
  assert.equal(perfilAtivo(),null);
  assert.equal(perfilAtivo.codigoErro,'ENOENT');
  writeFileSync(join(dir,'arquivo'),'');
  process.env.FIREFOX_PROFILE=join(dir,'arquivo');
  assert.equal(perfilAtivo(),null);
  assert.equal(perfilAtivo.codigoErro,'ENOTDIR');
  process.env.FIREFOX_PROFILE=dir;
  assert.equal(perfilAtivo(),dir);
  assert.equal(perfilAtivo.erro,null);
  assert.equal(perfilAtivo.codigoErro,null);
 } finally {
  if(anterior===undefined) delete process.env.FIREFOX_PROFILE; else process.env.FIREFOX_PROFILE=anterior;
  rmSync(dir,{recursive:true,force:true});
 }
});
