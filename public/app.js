import { dashboard, compactSection, removal } from './dashboard.js';
import { thermalAssessment, terminalStatuses, commandOutcome } from './hardware.js';
const $ = selector => document.querySelector(selector);
const app = $('#app');
const icons = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  fan:'<circle cx="12" cy="12" r="2"/><path d="M10 10C4 7 8 1 12 3c3 1 2 5 1 7M14 11c5-5 10 0 6 4-2 2-5 0-7-1M11 14c1 7-6 8-7 3-1-3 3-4 6-4"/>',
  chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  plug:'<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5"/>',
  home:'<path d="m3 10 9-8 9 8v11H3Z"/><path d="M12 7v12m-5-8 5 4 5-4"/><circle cx="7" cy="11" r="1"/><circle cx="17" cy="11" r="1"/>',
  folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  temp:'<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 7v10"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  server:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M6 15h2m3 0h7"/>',
  activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".5"/>',
  bluetooth:'<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  sound:'<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  bolt:'<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
};
const icon = name => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.grid) + '</svg>';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles = { overview:'Visão geral', cooling:'Controle térmico', energy:'Energia e desempenho', devices:'Periféricos', home:'Home Assistant', install:'Instalação e arquivos', events:'Atividade', remove:'Desinstalar agente' };
let page = 'overview', state = null, demo = false, pairing = null, chartRange = 60, busy = false, selectedHost = null;
const host = () => state?.hosts.find(h => h.id === selectedHost && !h.revoked) || state?.hosts.find(h => !h.revoked);
const telemetry = () => host()?.telemetry || {};
const connected = () => Boolean(host()?.online);
const disabled = cap => !connected() || !telemetry().capabilities?.[cap] ? 'disabled' : '';
const labelProfile = value => ({automatic:'Automático',balanced:'Equilibrado',cool:'Resfriar',maximum:'Máximo · 5 min',original:'Original',eco:'Econômico',performance:'Desempenho'}[value] || value);
const dt = value => value ? new Date(value).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
let previousCommands = null, apiFailed = false, formDirty = false, modalOpener = null;
function toast(message, kind = 'info') {
  const item = document.createElement('div'); item.className = 'notification ' + kind;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label','Dispensar notificação'); close.onclick = () => item.remove();
  item.append(text, close); $('#toast').append(item);
  while ($('#toast').children.length > 5) $('#toast').firstElementChild.remove();
  if (kind !== 'error') setTimeout(() => item.remove(), kind === 'success' ? 9000 : 6000);
}
function observeState(next) {
  if (previousCommands) {
    for (const cmd of next.commands) if (terminalStatuses.has(cmd.status) && previousCommands.get(cmd.id) !== cmd.status) {
      const outcome = commandOutcome(cmd); toast(outcome.message, outcome.kind);
    }
    for (const h of next.hosts) {
      const before = state?.hosts.find(old => old.id === h.id);
      if (before && !h.revoked && before.online !== h.online) toast(h.online ? 'Agente conectado novamente.' : 'Agente perdeu contato. Controles bloqueados.', h.online ? 'success' : 'error');
    }
    if (state?.mqtt.status !== next.mqtt.status) {
      if (next.mqtt.status === 'connected') toast('Conexão MQTT confirmada. Home Assistant pode descobrir as entidades.', 'success');
      if (next.mqtt.status === 'offline') toast('MQTT sem conexão. ' + (next.mqtt.error || 'Confira o broker.'), 'error');
    }
  }
  previousCommands = new Map(next.commands.map(c => [c.id,c.status]));
}
async function api(route, data) {
  const res = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type':'application/json'}, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await res.json(); if (!res.ok) throw Object.assign(new Error(value.error), {status:res.status}); return value;
}
function login(error = '') {
  if ($('#toast')) document.body.append($('#toast'));
  state = null;
  previousCommands = null; formDirty = false; document.body.classList.remove('modal-open');
  app.innerHTML = '<main class="login"><section class="login-card"><div class="brand"><span class="brand-logo">M</span><span>mini control<span class="muted">.</span></span></div><div class="kicker">Hardware, em sintonia</div><h1>Seu Mac mini.<br>Sob seu controle.</h1><p>Temperatura, energia e automações em um só lugar. Conecte seu agente para começar.</p><form id="login-form"><label for="token">Chave de acesso do painel</label><input id="token" type="password" autocomplete="current-password" placeholder="Sua ADMIN_TOKEN" required><button class="primary">Acessar painel ' + icon('arrow') + '</button><div class="error">' + esc(error) + '</div></form><button class="ghost demo-btn" data-do="demo">Explorar demonstração</button><small>Primeiro acesso? Use a chave definida no arquivo .env do Docker. A instalação do agente começa dentro do painel.</small></section></main>';
}
function demoState() {
  const now = Date.now(), id = 'demo-mac-mini';
  const points = Array.from({length:121}, (_, i) => ({at:now-(120-i)*30000,temperature:47+Math.sin(i*.2)*3+Math.sin(i*.67)*1.4,rpm:1900+Math.cos(i*.16)*110}));
  return {version:'0.1.0',publicUrl:'http://192.168.1.100:8787',hosts:[{id,name:'macmini-lab',online:true,seen:now,installed:now-86400000*4,telemetry:{
    model:'Macmini6,2',version:'0.1.0',temperatures:[{id:'cpu',label:'coretemp · CPU Package',value:48.2},{id:'smc',label:'applesmc · TC0P',value:44.8},{id:'disk',label:'applesmc · TH0P',value:35.6}],fans:[{id:'fan1',rpm:1860,min:1800,max:5500,controllable:true}],
    fanProfile:'balanced',cpuProfile:'balanced',cpu:{noTurbo:0,maxPerformance:85},capabilities:{fan:true,cpu:true,radios:true,usb:true,audio:true},
    radios:[{id:'rfkill0',type:'wifi',name:'Wi-Fi integrado',blocked:true},{id:'rfkill1',type:'bluetooth',name:'Bluetooth 4.0',blocked:false}],
    usb:[{id:'1-1',name:'Teclado USB',mode:'auto',controllable:true},{id:'2-1',name:'Armazenamento USB',mode:'on',controllable:false}],audio:{volume:35,control:'Master'},
    inventory:[{path:'/opt/macmini-controller/agent.py',status:'ok',size:18000},{path:'/opt/macmini-controller/uninstall.sh',status:'ok',size:2400},{path:'/etc/macmini-controller/agent.json',status:'ok',size:220},{path:'/etc/systemd/system/macmini-controller.service',status:'ok',size:800}],
    diagnostics:{sleepStates:'freeze mem disk',rtcAlarm:true,efi:true,powercap:['intel-rapl']},
  }}],history:{[id]:points},commands:[],events:[
    {at:now-60000,kind:'success',message:'Curva térmica equilibrada aplicada no host.'},
    {at:now-360000,kind:'mqtt',message:'Home Assistant conectado. Entidades disponíveis.'},
    {at:now-520000,kind:'install',message:'Inventário verificado. Todos os arquivos íntegros.'},
  ],mqtt:{status:'connected',url:'mqtt://192.168.1.50:1883',username:'mini-control',base:'macmini/demonstracao',hasPassword:true}};
}
function render() {
  if (!state) return login();
  const h = host();
  const detailState = new Map([...document.querySelectorAll('details[data-disclosure]')].map(d => [d.dataset.disclosure,d.open]));
  if (!$('#dashboard-main')) {
    app.innerHTML = '<main class="single-workspace"><header class="workspace-header"><div class="brand"><span class="brand-logo">M</span><span>mini control.</span></div><div class="top-actions"><span id="connection-label" class="status-detail"></span><button class="ghost mini-button" data-do="logout">'+(demo?'Sair da demo':'Sair')+'</button></div></header><div class="content"><div id="demo-label"></div><section class="page-head"><div><div class="kicker">SEU MAC, EM SINTONIA</div><h1>Visão geral</h1><p>O essencial à vista. Os detalhes, quando você precisar.</p></div><button data-page="install">'+icon('settings')+' Gerenciar agente</button></section><div id="dashboard-main"></div></div></main><dialog id="detail-dialog" aria-labelledby="dialog-title"><header class="dialog-header"><div><small>MINI CONTROL</small><h2 id="dialog-title"></h2></div><button data-do="close-modal" aria-label="Fechar janela">×</button></header><div id="dialog-body"></div></dialog>';
    $('#detail-dialog').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
  }
  $('#connection-label').innerHTML = '<span class="dot '+(connected()?'online':'')+'"></span>'+(demo?'Demonstração':connected()?'Agente conectado':'Sem contato com o agente');
  $('#demo-label').innerHTML = demo ? '<div class="banner">Demonstração · dados ilustrativos. Nenhuma ação afeta seu Mac.</div>' : '';
  const active = document.activeElement;
  if (!['SELECT','INPUT'].includes(active?.tagName) || !$('#dashboard-main').contains(active)) {
    $('#dashboard-main').innerHTML = dashboard({state,h,demo,esc,icon,dt,labelProfile,chart,profileSelect,chartRange,events});
  }
  const dialog = $('#detail-dialog');
  if (page !== 'overview') {
    const changed = dialog.dataset.page !== page;
    if (changed || (!formDirty && !['INPUT','SELECT','TEXTAREA'].includes(active?.tagName))) {
      const scroll = changed ? 0 : $('#dialog-body').scrollTop;
      const focusedDisclosure = active?.closest('details')?.dataset.disclosure;
      $('#dialog-title').textContent = titles[page];
      $('#dialog-body').innerHTML = page === 'remove' ? removal(h,esc) : compactSection(page,content(),telemetry(),state.commands.filter(c => c.hostId === h?.id),esc);
      dialog.dataset.page = page;
      $('#dialog-body').scrollTop = scroll;
      if (focusedDisclosure) $('#dialog-body').querySelector('[data-disclosure="'+focusedDisclosure+'"] summary')?.focus({preventScroll:true});
    }
    if (!dialog.open) { dialog.showModal(); document.body.classList.add('modal-open'); }
    dialog.append($('#toast'));
  } else if (dialog.open) { document.body.append($('#toast')); dialog.close(); document.body.classList.remove('modal-open'); }
  for (const d of document.querySelectorAll('details[data-disclosure]')) if (detailState.has(d.dataset.disclosure)) d.open = detailState.get(d.dataset.disclosure);
  for (const select of document.querySelectorAll('[data-profile="fan"]')) for (const option of select.options) if (['balanced','cool'].includes(option.value)) option.disabled = thermalAssessment(telemetry()).needsReview;
}
function closeModal() {
  page = 'overview'; formDirty = false; render();
  if (modalOpener) document.querySelector('[data-page="'+modalOpener+'"]')?.focus({preventScroll:true});
}
function chart(history) {
  const points=history.filter(p=>p.at>Date.now()-chartRange*60000), w=620,h=155;
  const ceiling=Math.max(100,Math.ceil(Math.max(0,...points.map(p=>Number.isFinite(p.temperature)?p.temperature:0))/20)*20);
  const grid=Array.from({length:5},(_,i)=>20+i*(ceiling-20)/4).map(v=>{const y=140-(v-20)/(ceiling-20)*130;return '<line x1="28" y1="'+y+'" x2="605" y2="'+y+'" stroke="#edf0e8" stroke-dasharray="3 5"/><text x="0" y="'+(y+3)+'">'+v+'°</text>';}).join('');
  const line=(key,min,max)=>points.filter(p=>Number.isFinite(p[key])).map((p,i,a)=>{const x=32+(a.length===1?0:i/(a.length-1))*568,y=140-Math.max(0,Math.min(1,(p[key]-min)/(max-min)))*130;return x.toFixed(1)+','+y.toFixed(1);}).join(' ');
  return '<div class="chart"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" role="img" aria-label="Histórico da maior leitura bruta dos sensores. Temperatura de 20 a '+ceiling+' graus; ventoinha de 0 a 6000 RPM.">'+grid+(points.length?'<polyline fill="none" stroke="#83a593" stroke-width="1.8" points="'+line('rpm',0,6000)+'"/><polyline fill="none" stroke="#e9976c" stroke-width="2" points="'+line('temperature',20,ceiling)+'"/>':'')+'<text x="30" y="153">'+(points.length?new Date(points[0].at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'—')+'</text><text x="573" y="153">agora</text></svg>'+(!points.length?'<div class="chart-empty">O histórico começa com a primeira leitura.</div>':'')+'</div>';
}
function profileSelect(name,cap,value,choices) { return '<select aria-label="Perfil '+name+'" data-profile="'+name+'" '+disabled(cap)+'>'+choices.map(x=>'<option value="'+x+'" '+(x===value?'selected':'')+'>'+labelProfile(x)+'</option>').join('')+'</select>'; }
function profiles(type,choices,descriptions) {
  const t=telemetry(),current=type==='fan'?t.fanProfile:t.cpuProfile;
  return '<div class="profile-grid">'+choices.map((p,i)=>'<button class="profile-option '+(current===p?'active':'')+'" data-action="'+type+'.profile" data-value="'+p+'" '+disabled(type)+'>'+icon(type==='fan'?'fan':'bolt')+'<strong>'+labelProfile(p)+'</strong><small>'+descriptions[i]+'</small></button>').join('')+'</div>';
}
function cooling() {
  const t=telemetry();
  return '<section class="card"><div class="card-head"><div><h2>Como seu Mac deve resfriar?</h2><p>Controle pelo SMC; nenhuma rotação abaixo do mínimo original.</p></div><span class="pill gray">Curva local</span></div>'+profiles('fan',['automatic','balanced','cool','maximum'],['Entrega o controle ao firmware e restaura o mínimo original.','Eleva gradualmente a rotação mínima entre 45 e 78 °C.','Resfriamento antecipado, entre 40 e 70 °C.','Máximo por 5 minutos; depois volta ao equilibrado.'])+'<div class="info-box">'+icon('shield')+' O agente continua a curva mesmo sem conexão com o painel. Em 85 °C ou sem leitura de sensores, os perfis controlados solicitam rotação máxima. Um encerramento do serviço tenta restaurar o automático.</div>'+(t.thermalWarning?'<div class="banner">'+esc(t.thermalWarning)+'</div>':'')+(!t.capabilities?.fan?'<p class="tab-note">Controles aguardando um SMC compatível, limites válidos e permissão de escrita no host.</p>':'')+'</section><div class="sensor-grid">'+(t.temperatures||[]).map(s=>'<article class="card"><small>'+esc(s.label)+'</small><div class="sensor-value">'+esc(s.value)+' <span>°C</span></div></article>').join('')+'</div><section class="card section-gap"><h2>Ventoinhas detectadas</h2><div class="table-scroll"><table><thead><tr><th>Identificador</th><th>Rotação</th><th>Mínimo atual</th><th>Máximo</th></tr></thead><tbody>'+(t.fans||[]).map(f=>'<tr><td>'+esc(f.id)+'</td><td>'+esc(f.rpm)+' rpm</td><td>'+esc(f.min)+' rpm</td><td>'+esc(f.max)+' rpm</td></tr>').join('')+'</tbody></table></div>'+(!t.fans?.length?empty('Aguardando a descoberta das ventoinhas.'): '')+'</section>';
}
function energy() {
  const t=telemetry(),d=t.diagnostics||{};
  return '<section class="card"><div class="card-head"><div><h2>Perfil do processador</h2><p>Altera os limites Intel P-state no host inteiro.</p></div>'+icon('bolt')+'</div>'+profiles('cpu',['original','eco','balanced','performance'],['Restaura os valores capturados antes do primeiro ajuste.','Turbo desativado e limite de desempenho em 60%.','Turbo permitido e limite de desempenho em 85%.','Turbo permitido e limite de desempenho em 100%.'])+'<div class="info-box">Estes ajustes afetam todas as cargas do servidor. A desinstalação restaura os valores originais registrados pelo agente.</div></section><section class="card section-gap"><div class="card-head"><div><h2>Recursos de energia e firmware</h2><p>Diagnóstico de suporte. Escrita avançada não habilitada nesta versão.</p></div><span class="pill orange">Diagnóstico</span></div><table><tbody><tr><td>Estados de suspensão</td><td class="mono">'+esc(d.sleepStates||'Aguardando leitura')+'</td></tr><tr><td>Interface de alarme RTC</td><td>'+availability(d.rtcAlarm)+'</td></tr><tr><td>Variáveis EFI</td><td>'+availability(d.efi)+'</td></tr><tr><td>Domínios powercap</td><td>'+esc(d.powercap?.join(', ')||'Nenhum identificado')+'</td></tr><tr><td>Wake-on-LAN / retorno após falta de energia</td><td>Exige validação física do modelo e firmware</td></tr></tbody></table><p class="tab-note">A presença da interface não comprova que acordar de suspensão ou de desligamento funciona neste Mac.</p></section>';
}
function availability(v) {return v===undefined?'Aguardando leitura':v?'Interface detectada':'Não detectado';}
function devices() {
  const t=telemetry();
  return '<div class="two-col"><section class="card"><div class="card-head"><div><h2>Rádios</h2><p>Wi-Fi e Bluetooth integrados</p></div>'+icon('wifi')+'</div>'+(t.radios||[]).map(r=>'<div class="control-row"><div class="control-label"><span class="icon-box">'+icon(r.type==='wifi'?'wifi':'bluetooth')+'</span><div><strong>'+esc(r.name)+'</strong><small>'+(r.hardBlocked?'Bloqueado pelo hardware':r.blocked?'Desativado':'Ativado')+'</small></div></div><button class="mini-button" data-radio="'+esc(r.type)+'" data-blocked="'+(!r.blocked)+'" '+disabled('radios')+'>'+(r.blocked?'Ativar':'Desativar')+'</button></div>').join('')+(!t.radios?.length?empty('Nenhum rádio identificado.'): '')+'<p class="tab-note">Desativar Wi-Fi encerra conexões que dependem dele. Use Ethernet para administrar o host.</p></section><section class="card"><div class="card-head"><div><h2>Áudio local</h2><p>Volume da saída principal detectada pelo ALSA</p></div>'+icon('sound')+'</div><form id="audio-form"><label for="volume">Volume · '+esc(t.audio?.volume??'—')+'%</label><input id="volume" name="volume" type="range" min="0" max="100" value="'+(t.audio?.volume??30)+'" '+disabled('audio')+'><button class="section-gap" '+disabled('audio')+'>Aplicar volume</button></form><p class="tab-note">Se necessário, instale alsa-utils manualmente no Proxmox. O agente não instala pacotes por conta própria.</p></section></div><section class="card section-gap"><div class="card-head"><div><h2>Dispositivos USB</h2><p>Suspensão automática de periféricos compatíveis</p></div>'+icon('plug')+'</div><table><thead><tr><th>Dispositivo</th><th>Porta</th><th>Política</th></tr></thead><tbody>'+(t.usb||[]).map(u=>'<tr><td>'+esc(u.name)+'</td><td>'+esc(u.id)+'</td><td>'+(!u.controllable?'<span class="pill gray">Protegido</span>':'<select aria-label="Política USB '+esc(u.name)+'" data-usb="'+esc(u.id)+'" '+disabled('usb')+'><option value="on" '+(u.mode==='on'?'selected':'')+'>Sempre ativo</option><option value="auto" '+(u.mode==='auto'?'selected':'')+'>Suspensão automática</option></select>')+'</td></tr>').join('')+'</tbody></table><p class="tab-note">Armazenamento, hubs e classes de rede ficam protegidos. Suspender logicamente não significa cortar os 5 V da porta.</p></section>';
}
function mqttLabel() {return ({connected:'Conectado',disabled:'Não configurado',connecting:'Conectando',offline:'Sem conexão'}[state.mqtt.status]||state.mqtt.status);}
function homePage() {
  const m=state.mqtt,base=m.base+'/'+(host()?.id||'ID_DO_HOST');
  return '<div class="two-col"><section class="card"><div class="card-head"><div><h2>Conectar ao seu broker MQTT</h2><p>Use o mesmo broker configurado no Home Assistant.</p></div><span class="pill '+(m.status==='connected'?'':'gray')+'">'+mqttLabel()+'</span></div><form id="mqtt-form"><div class="form-field"><label for="mqtt-url">Endereço do broker</label><input id="mqtt-url" name="url" placeholder="mqtt://192.168.1.50:1883" value="'+esc(m.url)+'"></div><div class="form-grid"><div class="form-field"><label for="mqtt-user">Usuário</label><input id="mqtt-user" name="username" value="'+esc(m.username)+'" autocomplete="username"></div><div class="form-field"><label for="mqtt-password">Senha</label><input id="mqtt-password" name="password" type="password" autocomplete="new-password" placeholder="'+(m.hasPassword?'Salva · deixe vazio para manter':'Senha do broker')+'"></div></div><button class="primary">Salvar conexão</button><button type="button" class="ghost" data-do="mqtt-disable">Desconectar</button></form>'+(m.error?'<p class="error">'+esc(m.error)+'</p>':'')+'<p class="tab-note">Suporte a mqtt:// e mqtts:// com certificado válido. Credenciais ficam no volume persistente e não são devolvidas ao navegador.</p></section><section class="card"><div class="integration-box"><span class="ha-logo">'+icon('home')+'</span><div><h2>Descoberta automática</h2><p>Um dispositivo para cada Mac conectado.</p></div></div><div class="control-row"><span>Temperaturas e RPM</span><span class="pill">Sensores</span></div><div class="control-row"><span>Resfriamento e energia</span><span class="pill">Seletores</span></div><div class="control-row"><span>Wi-Fi e Bluetooth</span><span class="pill">Interruptores</span></div><div class="control-row"><span>Integridade dos arquivos</span><span class="pill">Diagnóstico</span></div><div class="info-box">No Home Assistant, adicione a integração MQTT. As entidades aparecem conforme as capacidades do agente. Quando o agente ou painel cai, elas ficam indisponíveis.</div></section></div><section class="card section-gap"><h2>Exemplo de automação: resfriar às 14h</h2><p>Publique um comando sem retenção. Ele só é aceito enquanto o agente está online.</p><pre class="code">'+esc('alias: Mac mini - resfriar à tarde\ntriggers:\n  - trigger: time\n    at: "14:00:00"\nactions:\n  - action: mqtt.publish\n    data:\n      topic: '+base+'/set/fan\n      payload: "cool"\n      retain: false\nmode: single')+'</pre><p class="tab-note">O modo maximum dura 5 minutos. Perfis balanced e cool continuam localmente até você mudar ou reiniciar o agente.</p></section>';
}
function installation() {
  const t=telemetry(),files=t.inventory||[], h=host();
  return '<div class="two-col"><section class="card"><div class="card-head"><div><h2>Conectar seu Mac mini</h2><p>Docker no LXC. Agente no host Proxmox.</p></div><span class="pill gray">Passo a passo</span></div><div class="step"><div class="step-number">1</div><div class="step-content"><h3>Defina o endereço do painel</h3><p>Informe o IP do LXC, acessível pelo Proxmox. Não use localhost.</p><form id="pair-form"><label for="public-url">URL acessível do painel</label><input id="public-url" name="url" value="'+esc(state.publicUrl||location.origin)+'" placeholder="http://IP-DO-LXC:8787" required><button class="primary">Gerar comando de instalação</button></form></div></div><div class="step"><div class="step-number">2</div><div class="step-content"><h3>Execute no Shell do nó Proxmox</h3><p>Abra o nó físico → Shell e execute como root. O comando verifica o host, baixa o agente e cria o serviço.</p>'+(pairing?'<pre class="code" id="pair-command">'+esc(pairing.command)+'</pre><button data-copy="pair-command" class="mini-button">'+icon('copy')+' Copiar comando</button><p class="help-text">Válido até '+dt(pairing.expires)+'. Token de pareamento de uso único.</p>'+(pairing.insecure?'<div class="info-box warning">HTTP transporta o token sem criptografia. Use somente uma rede local confiável/VPN ou configure HTTPS.</div>':''):'<div class="info-box">O comando aparecerá aqui depois de definir o endereço.</div>')+'</div></div><div class="step"><div class="step-number">3</div><div class="step-content"><h3>Espere a primeira leitura</h3><p>O agente se conecta a cada 5 segundos. Os controles são habilitados após identificar o hardware.</p><span class="pill '+(connected()?'':'gray')+'">'+(connected()?'Agente conectado':'Aguardando agente')+'</span></div></div></section><section class="card"><div class="card-head"><div><h2>Uma instalação rastreável</h2><p>Arquivos organizados e remoção explícita.</p></div>'+icon('folder')+'</div><table><tbody><tr><td>Programa</td><td><code>/opt/macmini-controller/</code></td></tr><tr><td>Configuração e credencial</td><td><code>/etc/macmini-controller/</code></td></tr><tr><td>Inventário e ajustes originais</td><td><code>/var/lib/macmini-controller/</code></td></tr><tr><td>Serviço</td><td><code>macmini-controller.service</code></td></tr><tr><td>Logs</td><td><code>journalctl -u macmini-controller</code></td></tr></tbody></table><div class="info-box">A cada 30 segundos, o agente verifica hashes dos arquivos registrados e entradas extras nas pastas de programa e configuração. O conteúdo da credencial nunca é enviado ao painel.</div><h3>Atualizar o agente</h3><p>Na versão 0.1, remova a instalação atual e gere um novo comando de pareamento. O backup local e o histórico permanecem disponíveis.</p><h3>Remover do Mac</h3><p>Restaura ajustes registrados, desativa o serviço e move os arquivos para um backup em /var/backups/.</p><pre class="code" id="remove-command">bash /opt/macmini-controller/uninstall.sh</pre><button data-copy="remove-command" class="mini-button">'+icon('copy')+' Copiar remoção</button><p class="help-text">A remoção é executada por você no Shell do host.</p>'+(h?'<button class="danger mini-button" data-do="revoke" '+(connected()?'disabled':'')+'>Revogar vínculo após remoção</button>':'')+'</section></div><section class="card section-gap"><div class="card-head"><div><h2>Inventário monitorado</h2><p>Alterações, arquivos ausentes e entradas inesperadas</p></div><span class="pill '+(files.some(f=>f.status!=='ok')?'orange':'gray')+'">'+files.length+' arquivos</span></div><div class="table-scroll"><table><thead><tr><th>Caminho</th><th>Estado</th><th>Tamanho</th></tr></thead><tbody>'+files.map(f=>'<tr><td><code>'+esc(f.path)+'</code></td><td><span class="pill '+(f.status==='ok'?'':'orange')+'">'+({ok:'Íntegro',modified:'Alterado',missing:'Ausente',unexpected:'Não registrado'}[f.status]||esc(f.status))+'</span></td><td>'+esc(f.size)+' B</td></tr>').join('')+'</tbody></table></div>'+(!files.length?empty('O inventário aparece após instalar o agente.'): '')+'</section>';
}
function events(items) {return items.length?items.map(e=>'<div class="event-row"><span class="event-icon">'+icon(e.kind==='warning'||e.kind==='error'?'activity':'check')+'</span><p>'+esc(e.message)+'</p><small>'+dt(e.at)+'</small></div>').join(''):empty('As ações e alterações aparecerão aqui.');}
function eventsPage() {return '<section class="card"><h2>Comandos recentes</h2><p>Enviado não significa aplicado: o agente confirma o resultado.</p><div class="table-scroll"><table><thead><tr><th>Ação</th><th>Origem</th><th>Estado</th><th>Resultado</th></tr></thead><tbody>'+state.commands.slice(0,30).map(c=>'<tr><td>'+esc(c.action)+'</td><td>'+esc(c.source)+'</td><td>'+esc({queued:'Na fila',sent:'Enviado',done:'Aplicado',failed:'Falhou',expired:'Expirado',unknown:'Sem confirmação',interrupted:'Interrompido'}[c.status]||c.status)+'</td><td>'+esc(c.message||'—')+'</td></tr>').join('')+'</tbody></table></div></section><section class="card section-gap"><h2>Registro de atividade</h2>'+events(state.events.slice(0,80))+'</section>';}
function empty(message) {return '<div class="empty">'+icon('server')+'<p>'+esc(message)+'</p></div>';}
function content() {return ({cooling,energy,devices,home:homePage,install:installation,events:eventsPage}[page])();}
async function refresh(force=false) {
  if(demo)return;
  try {const next=await api('state');observeState(next);state=next;if(apiFailed)toast('Conexão com o painel restabelecida.','success');apiFailed=false;if(force||!busy)render();}
  catch(e){if(e.status===401){login();}else if(!apiFailed){apiFailed=true;toast('Não foi possível atualizar o painel. Os valores exibidos podem estar desatualizados. '+e.message,'error');}}
}
async function command(action,args) {
  if(demo){toast('Demonstração: nenhum comando foi enviado.');render();return;}
  busy=true;
  try {const cmd=await api('command',{hostId:host()?.id,action,args});previousCommands?.set(cmd.id,cmd.status);toast('Comando enviado — aguardando confirmação do agente.');await refresh(true);}
  catch(e){toast(e.message,'error');}finally{busy=false;}
}
app.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.page){if(page==='overview')modalOpener=b.dataset.page;page=b.dataset.page;formDirty=false;render();return;}
  if(b.dataset.range){chartRange=Number(b.dataset.range);render();return;}
  if(b.dataset.copy){const value=$('#'+b.dataset.copy)?.textContent;try{await navigator.clipboard.writeText(value);toast('Comando copiado.');}catch{toast('Selecione e copie o comando. Seu navegador exige HTTPS para copiar automaticamente.');}return;}
  if(b.dataset.action){await command(b.dataset.action,{profile:b.dataset.value});return;}
  if(b.dataset.radio){if(b.dataset.radio==='wifi'&&b.dataset.blocked==='true'&&!confirm('Desativar o Wi-Fi deste host? Conexões por Wi-Fi serão encerradas.'))return;await command('radio.set',{radio:b.dataset.radio,blocked:b.dataset.blocked==='true'});return;}
  const action=b.dataset.do;
  if(action==='close-modal'){closeModal();return;}
  if(action==='demo'){demo=true;state=demoState();page='overview';render();}
  if(action==='logout'){try{if(!demo)await api('logout',{});demo=false;pairing=null;$('#toast').replaceChildren();login();}catch(e){toast(e.message,'error');}}
  if(action==='mqtt-disable'){if(demo)return toast('Demonstração: configuração não alterada.');try{await api('mqtt',{url:'',username:'',password:''});formDirty=false;document.activeElement?.blur();await refresh(true);toast('Integração MQTT desativada.','success');}catch(e){toast(e.message,'error');}}
  if(action==='revoke'){if(demo)return toast('Demonstração: vínculo não alterado.');if(confirm('O agente já foi removido do host? A credencial será invalidada e as entidades MQTT removidas.'))try{await api('revoke',{hostId:host()?.id});await refresh(true);toast('Vínculo revogado. Histórico preservado.','success');}catch(e){toast(e.message,'error');}}
});
app.addEventListener('input',event=>{if(event.target.closest('#mqtt-form, #pair-form'))formDirty=true;});
app.addEventListener('error',event=>{if(event.target.tagName==='IMG')event.target.hidden=true;},true);
app.addEventListener('change',event=>{
  const el=event.target;
  if(el.dataset.profile)command(el.dataset.profile+'.profile',{profile:el.value});
  if(el.dataset.usb)command('usb.autosuspend',{id:el.dataset.usb,mode:el.value});
});
app.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;busy=true;
  try {
    if(form.id==='login-form'){await api('login',{token:$('#token').value});page='overview';await refresh(true);}
    else if(form.id==='pair-form'){
      if(demo){toast('Saia da demonstração para parear seu Mac.');return;}
      pairing=await api('pair',{url:new FormData(form).get('url')});state.publicUrl=new FormData(form).get('url');formDirty=false;document.activeElement?.blur();render();toast('Comando de instalação gerado. Validade: 15 minutos.','success');
    }else if(form.id==='mqtt-form'){
      if(demo){toast('Demonstração: conexão não alterada.');return;}
      const fields=Object.fromEntries(new FormData(form));if(!fields.password)delete fields.password;
      await api('mqtt',fields);formDirty=false;document.activeElement?.blur();await refresh(true);toast('Configuração salva. O estado da conexão será confirmado separadamente.','success');
    }else if(form.id==='audio-form'){await command('audio.volume',{volume:Number(new FormData(form).get('volume'))});}
  }catch(e){if(form.id==='login-form')login(e.message);else toast(e.message,'error');}finally{busy=false;}
});
await refresh(true);
setInterval(()=>{if(state&&!demo)refresh();},5000);
