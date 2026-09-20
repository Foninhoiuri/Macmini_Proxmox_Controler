import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { Store } from '../server/core.js';
import { Bridge } from '../server/mqtt.js';
const until = async fn => {const start=Date.now();while(!fn()){if(Date.now()-start>5000)throw new Error('Tempo excedido');await new Promise(r=>setTimeout(r,30));}};
test('MQTT real: discovery, controle, indisponibilidade e remoção',async()=>{
  const broker=await Aedes.createBroker();
  const server=net.createServer(broker.handle);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mini-mqtt-')),store=new Store(dir),bridge=new Bridge(store);
  const host=store.state.hosts.test={id:'test',name:'Mini',seen:Date.now(),telemetry:{capabilities:{fan:true},temperatures:[{id:'cpu',label:'CPU',value:48}],fans:[{id:'fan1',rpm:1800}],inventory:[]}};
  const url='mqtt://127.0.0.1:'+server.address().port;
  const client=await mqtt.connectAsync(url);
  const received=[];client.on('message',(topic,data)=>received.push({topic,value:data.toString()}));
  await client.subscribeAsync('#');
  try {
    await bridge.connect({url});
    await until(()=>received.some(m=>m.topic.includes('/fan_profile/config')));
    const config=JSON.parse(received.find(m=>m.topic.includes('/fan_profile/config')).value);
    assert.equal(config.availability_mode,'all');
    await client.publishAsync(bridge.base+'/test/set/fan','cool');
    await until(()=>store.state.commands.length===1);
    assert.equal(store.state.commands[0].source,'home-assistant');
    assert.equal(store.state.commands[0].args.profile,'cool');
    host.seen=Date.now()-60000;bridge.publish(host);
    await until(()=>received.some(m=>m.topic===bridge.base+'/test/availability'&&m.value==='offline'));
    await client.publishAsync(bridge.base+'/test/set/fan','maximum');
    await until(()=>store.state.events.some(e=>e.message.includes('offline')));
    assert.equal(store.state.commands.length,1);
    bridge.remove(host);
    await until(()=>received.some(m=>m.topic.includes('/fan_profile/config')&&m.value===''));
  }finally{await bridge.close();await client.endAsync();await new Promise(r=>broker.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});}
});
