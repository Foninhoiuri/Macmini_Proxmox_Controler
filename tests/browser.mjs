import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mini-ui-'));
const token='browser-test-token-at-least-32-characters';
const app=await createApp({dataDir:dir,adminToken:token,disableMqtt:true});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(base);await page.getByText('Explorar demonstração',{exact:true}).click();
  await page.getByRole('heading',{name:'Visão geral',exact:true}).waitFor();
  fs.mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
  for(const title of ['Controle térmico','Energia e desempenho','Periféricos','Home Assistant','Instalação e arquivos','Atividade']){
    await page.locator('nav').getByRole('button',{name:title,exact:true}).click();
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
  }
  await page.getByRole('button',{name:'Sair da demo',exact:true}).click();
  await page.locator('#token').fill(token);
  await page.getByRole('button',{name:/Acessar painel/}).click();
  await page.getByRole('heading',{name:'Visão geral',exact:true}).waitFor();
  await page.locator('nav').getByRole('button',{name:'Instalação e arquivos',exact:true}).click();
  await page.locator('#public-url').fill(base);
  await page.getByRole('button',{name:'Gerar comando de instalação',exact:true}).click();
  await page.locator('#pair-command').waitFor();
  assert.ok((await page.locator('#pair-command').innerText()).includes('curl'));
  await page.screenshot({path:'test-results/installation-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Sair',exact:true}).click();
  await page.getByText('Explorar demonstração',{exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Layout excedeu a tela mobile');
  assert.deepEqual(errors,[]);
  console.log('Interface: login, demo, 7 páginas, pareamento, desktop e mobile verificados.');
}finally{await browser.close();await app.close();fs.rmSync(dir,{recursive:true});}
