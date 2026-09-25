'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const S=require('../server.js');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const match=html.match(/function netCloseDisposition\(code,replaced\)\{[^}]+\}/);
assert.ok(match,'helper de decisão de fechamento deve existir no cliente');
const netCloseDisposition=Function(`${match[0]};return netCloseDisposition`)();

test('close 4001 é terminal mesmo sem mensagem session_replaced',()=>{
  assert.equal(netCloseDisposition(4001,false),'replaced');
  assert.match(html,/Sua sessão foi substituída por outra conexão\./);
});
test('queda 1006 continua agendando reconnect',()=>assert.equal(netCloseDisposition(1006,false),'reconnect'));
test('ban 4003 continua terminal',()=>assert.equal(netCloseDisposition(4003,false),'banned'));
test('flag sessionReplaced continua terminal independente do close code',()=>assert.equal(netCloseDisposition(1006,true),'replaced'));

test('handlers são socket-scoped e socket antigo não altera estado global',()=>{
  assert.match(html,/const ws=new WebSocket/);
  assert.ok((html.match(/if\(NET!==ws\)return/g)||[]).length>=4,'onopen/onmessage/onclose/onerror devem ignorar socket obsoleto');
  assert.match(html,/clientInstanceId:CLIENT_INSTANCE_ID/);
  assert.doesNotMatch(html,/localStorage[^\n]*CLIENT_INSTANCE_ID|CLIENT_INSTANCE_ID[^\n]*localStorage/);
});

test('clientInstanceId aceita somente formato curto e seguro',()=>{
  for(const ok of ['1234567890abcdef','abc_DEF-1234567890','a'.repeat(80)])assert.equal(S.validClientInstanceId(ok),true);
  for(const bad of ['',null,'curto','a'.repeat(81),'abc defghijklmnop','<script>'.repeat(4)])assert.equal(S.validClientInstanceId(bad),false);
});

test('decisão server-side distingue mesma instância de aba/aparelho diferente',()=>{
  const old={clientInstanceId:'same_page_12345678'};
  assert.equal(S.sessionReplacementMode(old,'same_page_12345678'),'same_instance');
  assert.equal(S.sessionReplacementMode(old,'other_page_1234567'),'different_instance');
  assert.equal(S.sessionReplacementMode(old,null),'different_instance');
});

test('servidor diferencia mesma instância (4000) de outra conexão (4001 + mensagem)',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.match(src,/old\.close\(4000,'Reconexão da mesma instância'\)/);
  assert.match(src,/send\(old,\{type:'session_replaced'\}\);old\.close\(4001,'Sessão substituída'\)/);
  assert.match(src,/console\.log\('session_replace'.*oldConnectionId.*newConnectionId.*sameClientInstance/);
  assert.match(src,/if\(sameClientInstance\)old\.close\(4000,[^)]+\);\s*else\{send\(old,\{type:'session_replaced'\}\)/);
  const transfer=src.indexOf('activeCharacterSockets.set(p.charId,ws)',src.indexOf('const sameClientInstance'));
  const close=src.indexOf("old.close(4000,'Reconexão da mesma instância')",src.indexOf('const sameClientInstance'));
  assert.ok(transfer<close,'autoridade deve mudar antes do close antigo');
});
