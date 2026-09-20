import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, enqueue, publicUrl, hash, matches, shellQuote, validateAction } from '../server/core.js';
import { discovery } from '../server/mqtt.js';

const telemetry = { capabilities: {fan:true,cpu:true,radios:true,usb:true}, radios:[{type:'wifi'}],usb:[{id:'1-1',controllable:false}],temperatures:[{id:'cpu',label:'CPU',value:50}],fans:[{id:'fan1',rpm:2000}] };
test('autenticação não aceita token diferente',()=>{assert.equal(matches('a',hash('b')),false);assert.equal(matches('a',hash('a')),true);assert.equal(matches(undefined,hash('a')),false);});
test('URLs rejeitam credenciais, caminhos e protocolos não HTTP',()=>{
  for(const url of ['file:///etc/passwd','http://user:pw@host','http://host/path','http://host/?x=1'])assert.throws(()=>publicUrl(url));
  assert.equal(publicUrl('https://mini.example/'),'https://mini.example');
  assert.throws(()=>publicUrl('http://host',true));
});
test('comandos não permitem shell, modo térmico desconhecido ou USB protegido',()=>{
  assert.throws(()=>validateAction('shell',{command:'reboot'},telemetry));
  assert.throws(()=>validateAction('fan.profile',{profile:'off'},telemetry));
  assert.throws(()=>validateAction('usb.autosuspend',{id:'1-1',mode:'auto'},telemetry));
  assert.throws(()=>validateAction('radio.set',{radio:'wifi',blocked:'true'},telemetry));
});
test('comando expira e host offline não recebe ações',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-test-')),store=new Store(dir);
  store.state.hosts.h={seen:0,telemetry};
  assert.throws(()=>enqueue(store,'h','fan.profile',{profile:'cool'}),/offline/);
  store.state.hosts.h.seen=Date.now();
  const c=enqueue(store,'h','fan.profile',{profile:'cool'});
  assert.ok(c.expires-c.at<=20000);assert.equal(c.status,'queued');
  const reloaded=new Store(dir);assert.equal(reloaded.state.commands[0].status,'interrupted');
  fs.rmSync(dir,{recursive:true});
});
test('discovery possui IDs estáveis e disponibilidade composta',()=>{
  const items=discovery({id:'test',name:'Mini',telemetry},'macmini/controller');
  assert.ok(items.some(i=>i.payload.name==='Perfil térmico'));
  for(const i of items){assert.ok(i.payload.unique_id);assert.equal(i.payload.availability.length,2);assert.equal(i.payload.availability_mode,'all');}
  assert.ok(!discovery({id:'test',name:'Mini',telemetry:{capabilities:{}}},'base').some(i=>i.topic.includes('/select/')));
});
test('shell quoting não interpola valores',()=>{assert.equal(shellQuote("a'b"),"'a'\\''b'");assert.equal(shellQuote('$(reboot)'),"'$(reboot)'");});
