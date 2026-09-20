import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
const ADMIN='test-admin-token-with-32-characters';
test('fluxo completo: login, pareamento, heartbeat, comando, confirmação e revogação',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mini-api-'));
  const app=await createApp({dataDir:dir,adminToken:ADMIN,disableMqtt:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const req=async(route,data,token=ADMIN)=>{const response=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,data:await response.json()};};
  try {
    assert.equal((await req('/api/state',undefined,'bad')).status,401);
    const csrf=await fetch(base+'/api/pair',{method:'POST',headers:{Origin:'http://evil.test',Authorization:'Bearer '+ADMIN,'Content-Type':'application/json'},body:JSON.stringify({url:base})});assert.equal(csrf.status,403);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ADMIN})});
    assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
    const paired=await req('/api/pair',{url:base});assert.equal(paired.status,200);
    const token=/Bearer ([a-f0-9]{64})/.exec(paired.data.command)[1];
    const installer=await fetch(base+'/bootstrap/install.sh',{headers:{Authorization:'Bearer '+token}});
    const script=await installer.text();assert.ok(!script.includes('@@SHA_'));assert.ok(script.includes('sha256sum'));
    const enrolled=await req('/agent/enroll',{name:'mini-test'},token);assert.equal(enrolled.status,200);
    assert.equal((await req('/agent/enroll',{name:'again'},token)).status,401);
    const {id,token:agent}=enrolled.data;
    const telemetry={version:'0.1.0',model:'Macmini6,2',capabilities:{fan:true},temperatures:[{id:'cpu',label:'CPU',value:50}],fans:[{id:'fan1',rpm:2000}],radios:[],usb:[],inventory:[]};
    assert.equal((await req('/agent/heartbeat',{telemetry},agent)).status,200);
    assert.equal((await req('/api/command',{hostId:id,action:'shell',args:{cmd:'id'}})).status,400);
    const cmd=await req('/api/command',{hostId:id,action:'fan.profile',args:{profile:'cool'}});assert.equal(cmd.status,202);
    const poll=await req('/agent/heartbeat',{telemetry},agent);assert.equal(poll.data.commands.length,1);
    assert.equal((await req('/agent/heartbeat',{telemetry},agent)).data.commands.length,0);
    await req('/agent/heartbeat',{telemetry,results:[{id:cmd.data.id,ok:true,message:'aplicado'}]},agent);
    const status=await req('/api/state');assert.equal(status.data.commands[0].status,'done');
    // Expiry must become visible even when no more heartbeats arrive.
    const queued=await req('/api/command',{hostId:id,action:'fan.profile',args:{profile:'maximum'}});
    app.store.state.commands.find(c=>c.id===queued.data.id).expires=Date.now()-1;
    assert.equal((await req('/api/state')).data.commands.find(c=>c.id===queued.data.id).status,'expired');
    const sent=await req('/api/command',{hostId:id,action:'fan.profile',args:{profile:'maximum'}});
    await req('/agent/heartbeat',{telemetry},agent);
    app.store.state.commands.find(c=>c.id===sent.data.id).expires=Date.now()-1;
    assert.equal((await req('/api/state')).data.commands.find(c=>c.id===sent.data.id).status,'unknown');
    assert.ok(!JSON.stringify(status.data).includes(agent));assert.ok(!JSON.stringify(status.data).includes('tokenHash'));
    assert.equal((await req('/api/revoke',{hostId:id})).status,409);
    app.store.state.hosts[id].seen=Date.now()-60000;
    assert.equal((await req('/api/revoke',{hostId:id})).status,200);
    assert.equal((await req('/agent/heartbeat',{telemetry},agent)).status,401);
    assert.equal((await req('/api/state',undefined,agent)).status,401);
  } finally {await app.close();fs.rmSync(dir,{recursive:true});}
});
