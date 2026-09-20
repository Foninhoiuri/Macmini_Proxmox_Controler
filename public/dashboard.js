import { thermalAssessment } from './hardware.js';

const photo = 'https://pacificmacs.com/wp-content/uploads/2020/01/Mini.png';
const ports = 'https://pacificmacs.com/wp-content/uploads/2020/01/2012-mini_.png';

export function dashboard(v) {
  const { state, h, esc, icon, dt, labelProfile, chart, profileSelect } = v;
  const t = h?.telemetry || {}, assessment = thermalAssessment(t);
  const files = t.inventory || [], drift = files.filter(f => f.status !== 'ok');
  const commands = state.commands.filter(c => c.hostId === h?.id);
  const pending = commands.filter(c => ['queued', 'sent'].includes(c.status));
  const lastFan = commands.find(c => c.action === 'fan.profile');
  const conflict = lastFan?.status === 'failed' && lastFan.message?.includes('controlador térmico');
  const stat = (title, value, note, symbol, target) => `<button class="card stat stat-link" data-page="${target}"><span class="stat-top">${title}${icon(symbol)}</span><span class="stat-value">${esc(value)}</span><span class="stat-note">${esc(note)} ${icon('arrow')}</span></button>`;
  const shortcut = (target, symbol, title, note) => `<button class="shortcut" data-page="${target}"><span class="icon-box">${icon(symbol)}</span><span><strong>${title}</strong><small>${note}</small></span>${icon('arrow')}</button>`;
  return `${!h ? '<div class="banner">O painel está pronto. Conecte o agente no host Proxmox.<button data-page="install">Conectar Mac</button></div>' : !h.online ? '<div class="banner">Agente offline. Estas são as últimas leituras; os comandos estão bloqueados.</div>' : ''}
    ${conflict || assessment.needsReview ? `<div class="attention-strip"><span>${icon('shield')} ${conflict ? 'Outro programa está controlando a ventoinha.' : 'Há leituras térmicas que precisam de validação.'}</span><button data-page="cooling" class="mini-button">Entender e resolver ${icon('arrow')}</button></div>` : ''}
    <div id="command-progress" role="status">${pending.length ? `<div class="pending-strip">${icon('clock')} ${pending.length} comando(s) aguardando confirmação do agente. Enviado ainda não significa aplicado.</div>` : ''}</div>
    <div class="stats">
      ${stat('Temperatura da CPU', assessment.cpuTemperature === null ? '—' : assessment.cpuTemperature.toFixed(1) + ' °C', 'Sensor do processador · ver todos', 'temp', 'cooling')}
      ${stat('Ventoinha', (t.fans?.[0]?.rpm?.toLocaleString('pt-BR') || '—') + ' RPM', labelProfile(t.fanProfile || 'automatic'), 'fan', 'cooling')}
      ${stat('Energia', t.cpuProfile ? labelProfile(t.cpuProfile) : '—', t.cpu?.maxPerformance !== undefined ? `Limite ${t.cpu.maxPerformance}% · turbo ${t.cpu.noTurbo ? 'desligado' : 'permitido'}` : 'Aguardando agente', 'bolt', 'energy')}
      ${stat('Agente', !files.length ? 'Não instalado' : drift.length ? 'Revisar' : 'Tudo íntegro', files.length ? files.length + ' arquivos monitorados' : 'Instalação guiada', 'folder', 'install')}
    </div>
    <div class="dashboard-grid">
      <section class="card chart-card"><div class="card-head"><div><h2>Pulso térmico</h2><p>Maior leitura bruta dos sensores · não é apenas a CPU</p></div><div class="chart-controls">${[60,360,1440].map(n => `<button data-range="${n}" class="${v.chartRange === n ? 'selected' : ''}">${({60:'1h',360:'6h',1440:'24h'})[n]}</button>`).join('')}</div></div><div class="legend"><span><i></i>Maior sensor</span><span><i class="green"></i>Ventoinha</span></div>${chart(state.history[h?.id] || [])}<div class="chart-foot"><span>LEITURAS A CADA 5 SEGUNDOS</span><button data-page="cooling" class="ghost mini-button">Ver sensores</button></div></section>
      <section class="card device-card"><div class="card-head"><div><h2>Pequeno. Incansável.</h2><p>${esc(t.model || 'Mac mini · Intel')}</p></div><span class="pill ${h?.online ? '' : 'gray'}">${h?.online ? 'Conectado' : 'Offline'}</span></div><div class="device-photo"><img src="${photo}" alt="Mac mini, vista superior" referrerpolicy="no-referrer"><span class="photo-fallback">Mac mini · 2012</span></div><div class="device-bottom"><span><strong>${esc(h?.name || 'Seu Mac mini')}</strong><small>Proxmox → agente local</small></span><button class="mini-button" data-page="devices">Ver portas ${icon('arrow')}</button></div></section>
      <section class="card quick-card wide"><div class="card-head"><div><h2>Ajustes rápidos</h2><p>O estado mostrado é o último confirmado pelo agente.</p></div>${icon('settings')}</div><div class="quick-controls"><div class="control-row"><div class="control-label">${icon('fan')}<strong>Resfriamento</strong></div>${profileSelect('fan','fan',t.fanProfile || 'automatic',['automatic','balanced','cool','maximum'])}</div><div class="control-row"><div class="control-label">${icon('bolt')}<strong>Energia</strong></div>${profileSelect('cpu','cpu',t.cpuProfile || 'original',['original','eco','balanced','performance'])}</div></div></section>
    </div>
    <section class="tools-section" aria-label="Controles e conexões"><div class="section-heading"><h2>O que você quer ajustar?</h2><small>Abra só o que precisar.</small></div><div class="shortcuts">
      ${shortcut('cooling','fan','Resfriamento','Perfis, sensores e alertas')}
      ${shortcut('energy','bolt','Energia','Limites e desempenho')}
      ${shortcut('devices','plug','Portas e dispositivos','Bluetooth, USB e áudio')}
      ${shortcut('home','home','Home Assistant',state.mqtt.status === 'connected' ? 'MQTT conectado' : 'Conectar automações')}
      ${shortcut('install','folder','Gerenciar agente','Instalar, arquivos e remover')}
      ${shortcut('events','clock','Atividade','Resultados e notificações')}
    </div></section>
    <details class="disclosure recent-activity" data-disclosure="recent"><summary>Últimos acontecimentos <span>${state.events.length} registros</span></summary><div class="disclosure-body">${v.events(state.events.slice(0,3))}<button data-page="events" class="ghost mini-button">Ver toda a atividade</button></div></details>
    <footer class="bottom-caption"><span>${icon('shield')} Controle local · nenhuma alteração automática no host</span><span>${v.demo ? 'Dados ilustrativos' : h ? 'Último contato: ' + dt(h.seen) : 'Aguardando instalação'}</span></footer>`;
}

export function thermalNotice(t, commands, esc) {
  const a = thermalAssessment(t), last = commands.find(c => c.action === 'fan.profile');
  const conflict = last?.status === 'failed' && last.message?.includes('controlador térmico');
  return `${conflict ? `<div class="notice error-notice"><strong>O último ajuste da ventoinha falhou</strong><p>${esc(last.message)}. O agente recusou a ação para não disputar o controle.</p><details data-disclosure="conflict"><summary>Como resolver com segurança</summary><p>O controlador atual foi mantido. Primeiro valide os sensores abaixo; depois planeje a troca no Shell do Proxmox. Este painel não para nem desinstala serviços de terceiros.</p><p>Diagnóstico somente de leitura:</p><pre class="code">systemctl status macfanctld --no-pager</pre><p>Não desative a proteção térmica só para liberar estes botões.</p></details></div>` : ''}
    ${a.needsReview ? `<div class="notice warning-notice"><strong>Leituras divergentes — validação necessária</strong><p>CPU: ${a.cpuTemperature} °C. ${a.unverified.map(s => `${esc(s.label)}: ${s.value} °C`).join('; ')}. Sensores de componentes diferentes podem divergir: isso não comprova defeito nem uma temperatura segura.</p><p>As leituras brutas foram preservadas. Os perfis Equilibrado e Resfriar ficam bloqueados até validar a origem dessas leituras. Não vamos ignorá-las automaticamente.</p></div>` : ''}`;
}

// Fold secondary information while preserving existing form IDs and handlers.
export function compactSection(page, html, t, commands, esc) {
  const root = document.createElement('div'); root.innerHTML = html;
  const fold = (node, title, key) => {
    if (!node) return;
    const details = document.createElement('details'); details.className = 'disclosure'; details.dataset.disclosure = key;
    const summary = document.createElement('summary'); summary.textContent = title;
    node.replaceWith(details); details.append(summary, node); node.classList.add('disclosure-body');
  };
  if (page === 'cooling') {
    fold(root.querySelector('.sensor-grid'), `Ver todos os sensores (${t.temperatures?.length || 0})`, 'sensors');
    fold(root.querySelector('section.section-gap'), 'Rotação e limites da ventoinha', 'fan-limits');
    root.insertAdjacentHTML('afterbegin', thermalNotice(t, commands, esc));
    if (thermalAssessment(t).needsReview) root.querySelectorAll('[data-action="fan.profile"]').forEach(b => {
      if (['balanced','cool'].includes(b.dataset.value)) { b.disabled = true; b.title = 'Valide as leituras térmicas antes de ativar a curva.'; }
    });
  }
  if (page === 'energy') {
    fold(root.querySelector('section.section-gap'), 'Diagnóstico de energia e firmware', 'firmware');
    root.insertAdjacentHTML('afterbegin', `<div class="notice"><strong>Valores lidos no host</strong><p>Limite de desempenho: ${esc(t.cpu?.maxPerformance ?? '—')}% · Turbo: ${t.cpu?.noTurbo === undefined ? 'não detectado' : t.cpu.noTurbo ? 'desligado' : 'permitido'}. Original e Desempenho podem ter os mesmos valores; escolher outro nome não garante mudança de frequência.</p></div>`);
  }
  if (page === 'devices') {
    fold(root.querySelector('section.section-gap'), 'Dispositivos USB e suspensão automática', 'usb');
    root.insertAdjacentHTML('afterbegin', `<details class="disclosure" data-disclosure="ports"><summary>Ver as portas do Mac mini 2012</summary><figure class="ports-photo"><img src="${ports}" alt="Painel traseiro e portas do Mac mini 2012" referrerpolicy="no-referrer"><figcaption>Foto de referência fornecida por você · Pacific Macs. A imagem não indica quais portas estão ocupadas.</figcaption></figure></details>`);
  }
  if (page === 'home') fold(root.querySelector('section.section-gap'), 'Exemplo de automação no Home Assistant', 'automation');
  if (page === 'install') {
    const columns = root.querySelector('.two-col');
    if (columns) {
      const [setup, tracking] = [...columns.children];
      columns.replaceWith(setup, tracking);
      if (t.version) fold(setup, 'Instalar ou conectar outro agente', 'setup');
      // Removal is a dedicated, always visible action rather than buried in a table.
      const removal = tracking.querySelector('#remove-command');
      if (removal) {
        let node = removal.previousElementSibling;
        while (node && node.tagName !== 'H3') { const previous = node.previousElementSibling; node.remove(); node = previous; }
        if (node) { while (node) { const next = node.nextElementSibling; node.remove(); node = next; } }
      }
      fold(tracking, 'Onde o agente está instalado e como atualizar', 'paths');
    }
    fold(root.querySelector('section.section-gap'), `Inventário monitorado (${t.inventory?.length || 0} arquivos)`, 'inventory');
    root.insertAdjacentHTML('afterbegin', `<section class="agent-summary"><span><strong>Agente ${esc(t.version || 'não instalado')}</strong><small>Arquivos verificados a cada 30 segundos.</small></span><button class="danger" data-page="remove">Desinstalar agente</button></section>`);
  }
  return root.innerHTML;
}

export function removal(h, esc) {
  return `<section class="notice warning-notice"><strong>Remover somente o agente do Mac</strong><p>O painel Docker e o histórico permanecem. O script tenta restaurar os ajustes registrados, para e desativa o serviço e move os arquivos para um backup recuperável em <code>/var/backups/macmini-controller-…</code>.</p><p>Se a restauração falhar, a remoção é interrompida e os arquivos são preservados. Nenhum pacote ou controlador de terceiros é removido.</p></section><section class="card"><h2>1. Execute no Shell do Proxmox</h2><p>No nó físico, como root — não no LXC nem no Docker:</p><pre id="remove-command" class="code">bash /opt/macmini-controller/uninstall.sh</pre><button data-copy="remove-command">Copiar comando de desinstalação</button><p class="help-text">Copiar não executa o comando. A API não oferece execução remota de shell.</p><h2 class="section-gap">2. Confira a conclusão no terminal</h2><p>O terminal informa se a remoção terminou e onde ficou o backup. Ficar offline sozinho não comprova a desinstalação.</p><h2 class="section-gap">3. Revogue o vínculo</h2><p>Após confirmar a remoção, invalide a credencial e retire as entidades MQTT. O histórico é preservado.</p><button class="danger" data-do="revoke" ${!h || h.online ? 'disabled' : ''}>Revogar vínculo após remoção</button><p class="help-text">${h?.online ? 'Agente ainda conectado. O vínculo será liberado para revogação após perder contato (cerca de 35 segundos).' : h ? 'Agente sem contato. Confirme no terminal que a remoção foi concluída.' : 'Nenhum agente vinculado.'}</p></section>`;
}
