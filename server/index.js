import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, secret, hash, matches, requireValue, publicUrl, shellQuote, online, enqueue, VERSION } from './core.js';
import { Bridge } from './mqtt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createApp(options = {}) {
  const dir = options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data');
  const store = new Store(dir);
  let admin = options.adminToken || process.env.ADMIN_TOKEN;
  if (!admin) {
    const tokenPath = path.join(dir, 'admin-token.txt');
    if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, secret(), { mode: 0o600 });
    admin = fs.readFileSync(tokenPath, 'utf8').trim();
    console.log('Chave de acesso disponível em ' + tokenPath);
  }
  requireValue(admin.length >= 24 && !admin.startsWith('SUBSTITUA'), 'Configure uma ADMIN_TOKEN aleatória com pelo menos 24 caracteres.');
  const adminHash = hash(admin), bridge = new Bridge(store);
  const config = store.state.mqtt || (process.env.MQTT_URL ? { url: process.env.MQTT_URL, username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD } : null);
  if (!options.disableMqtt) await bridge.connect(config);
  const sessions = new Map(), attempts = new Map();
  const bearer = req => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const isAdmin = req => {
    if (matches(bearer(req), adminHash)) return true;
    const sid = /(?:^|; )mc_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    return sid && sessions.get(hash(sid)) > Date.now();
  };
  const agentFor = req => Object.values(store.state.hosts).find(h => !h.revoked && matches(bearer(req), h.tokenHash));
  const enrollmentFor = req => Object.entries(store.state.enrollments).find(([digest, e]) => e.expires > Date.now() && matches(bearer(req), digest));
  const cleanHost = h => ({ id: h.id, name: h.name, seen: h.seen, online: online(h), revoked: h.revoked || false, installed: h.installed, telemetry: h.telemetry });
  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  async function body(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; requireValue(Buffer.byteLength(raw) <= 512000, 'Requisição muito grande.', 413); }
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
  }
  function originCheck(req) {
    if (!req.headers.origin) return;
    const allowed = [process.env.PUBLIC_URL, store.state.publicUrl, 'http://' + req.headers.host, 'https://' + req.headers.host].filter(Boolean);
    requireValue(allowed.includes(req.headers.origin), 'Origem não autorizada.', 403);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://pacificmacs.com; connect-src 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname;
      if (req.method === 'GET' && route === '/healthz') return send(res, 200, { ok: true, version: VERSION });
      if (req.method !== 'GET') originCheck(req);
      if (route === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress, prior = attempts.get(ip);
        requireValue(!prior || prior.until < Date.now() || prior.count < 10, 'Muitas tentativas. Tente novamente em 5 minutos.', 429);
        const { token } = await body(req);
        if (!matches(token, adminHash)) {
          attempts.set(ip, { count: prior && prior.until > Date.now() ? prior.count + 1 : 1, until: Date.now() + 300000 });
          return send(res, 401, { error: 'Chave de acesso inválida.' });
        }
        attempts.delete(ip);
        const sid = secret(); sessions.set(hash(sid), Date.now() + 12 * 3600000);
        res.setHeader('Set-Cookie', 'mc_session=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + (process.env.REQUIRE_HTTPS === '1' ? '; Secure' : ''));
        return send(res, 200, { ok: true });
      }
      if (route.startsWith('/bootstrap/') && req.method === 'GET') {
        const enrollment = enrollmentFor(req);
        requireValue(enrollment, 'Pareamento expirado. Gere outro comando no painel.', 401);
        const file = route.split('/').pop();
        requireValue(['install.sh', 'agent.py', 'uninstall.sh', 'macmini-controller.service'].includes(file), 'Arquivo não disponível.', 404);
        let content = fs.readFileSync(path.join(ROOT, 'agent', file), 'utf8');
        if (file === 'install.sh') {
          for (const asset of ['agent.py', 'uninstall.sh', 'macmini-controller.service']) content = content.replace('@@SHA_' + asset + '@@', hash(fs.readFileSync(path.join(ROOT, 'agent', asset))));
        }
        return send(res, 200, content, 'text/plain');
      }
      if (route === '/agent/enroll' && req.method === 'POST') {
        const enrollment = enrollmentFor(req); requireValue(enrollment, 'Pareamento inválido ou expirado.', 401);
        const payload = await body(req);
        requireValue(typeof payload.name === 'string' && payload.name.length > 0 && payload.name.length <= 100, 'Nome inválido.');
        const id = crypto.randomUUID(), token = secret();
        store.state.hosts[id] = { id, name: payload.name, tokenHash: hash(token), seen: 0, installed: Date.now(), telemetry: null };
        delete store.state.enrollments[enrollment[0]];
        store.event('install', 'Agente pareado: ' + payload.name, id);
        return send(res, 200, { id, token, interval: 5 });
      }
      if (route === '/agent/heartbeat' && req.method === 'POST') {
        const host = agentFor(req); requireValue(host, 'Agente não autorizado.', 401);
        const payload = await body(req);
        requireValue(payload.telemetry && typeof payload.telemetry === 'object', 'Telemetria inválida.');
        // Validate collections before persisting so a broken agent cannot poison the UI.
        for (const key of ['temperatures', 'fans', 'radios', 'usb', 'inventory']) requireValue(Array.isArray(payload.telemetry[key]) && payload.telemetry[key].length < 300, 'Telemetria inválida: ' + key);
        const previousDrift = JSON.stringify(host.telemetry?.inventory?.filter(f => f.status !== 'ok') || []);
        host.telemetry = payload.telemetry; host.seen = Date.now();
        for (const result of Array.isArray(payload.results) ? payload.results.slice(0, 20) : []) {
          const cmd = store.state.commands.find(c => c.id === result.id && c.hostId === host.id && c.status === 'sent');
          if (cmd) { cmd.status = result.ok ? 'done' : 'failed'; cmd.message = String(result.message || '').slice(0, 500); store.event(result.ok ? 'success' : 'error', cmd.action + ': ' + cmd.message, host.id); }
        }
        const drift = JSON.stringify(host.telemetry.inventory.filter(f => f.status !== 'ok'));
        if (drift !== previousDrift && drift !== '[]') store.event('warning', 'Mudança detectada nos arquivos do agente.', host.id);
        const history = store.state.history[host.id] ||= [];
        if (!history.length || Date.now() - history.at(-1).at >= 30000) {
          const values = host.telemetry.temperatures.map(t => t.value).filter(Number.isFinite);
          history.push({ at: Date.now(), temperature: values.length ? Math.max(...values) : null, rpm: host.telemetry.fans[0]?.rpm ?? null });
          store.state.history[host.id] = history.slice(-2880);
        }
        const pending = [];
        for (const cmd of store.state.commands.filter(c => c.hostId === host.id).sort((a, b) => a.at - b.at)) {
          if (['queued', 'sent'].includes(cmd.status) && cmd.expires < Date.now()) cmd.status = cmd.status === 'queued' ? 'expired' : 'unknown';
          if (cmd.status === 'queued') { cmd.status = 'sent'; pending.push(cmd); }
        }
        bridge.publish(host); store.save();
        return send(res, 200, { commands: pending, serverTime: Date.now() });
      }
      if (route.startsWith('/api/')) {
        requireValue(isAdmin(req), 'Entre com a chave de acesso.', 401);
        if (route === '/api/logout' && req.method === 'POST') {
          const sid = /(?:^|; )mc_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
          if (sid) sessions.delete(hash(sid));
          res.setHeader('Set-Cookie', 'mc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        if (route === '/api/state' && req.method === 'GET') {
          let changed = false;
          for (const cmd of store.state.commands) if (['queued', 'sent'].includes(cmd.status) && cmd.expires < Date.now()) {
            cmd.status = cmd.status === 'queued' ? 'expired' : 'unknown'; changed = true;
            store.event('warning', cmd.action + ': ' + (cmd.status === 'expired' ? 'expirou sem envio' : 'resultado não confirmado'), cmd.hostId);
          }
          if (changed) store.save();
          return send(res, 200, {
          version: VERSION, hosts: Object.values(store.state.hosts).map(cleanHost),
          events: store.state.events, commands: store.state.commands, history: store.state.history,
          publicUrl: store.state.publicUrl || process.env.PUBLIC_URL || '',
          mqtt: { status: bridge.status, error: bridge.error, url: (store.state.mqtt || config)?.url || '', username: (store.state.mqtt || config)?.username || '', hasPassword: Boolean((store.state.mqtt || config)?.password), base: bridge.base },
          });
        }
        if (route === '/api/pair' && req.method === 'POST') {
          const payload = await body(req);
          const origin = publicUrl(payload.url, process.env.REQUIRE_HTTPS === '1');
          const token = secret();
          store.state.publicUrl = origin;
          store.state.enrollments[hash(token)] = { expires: Date.now() + 15 * 60000 };
          store.event('pair', 'Comando de instalação gerado; validade de 15 minutos.');
          const header = shellQuote('Authorization: Bearer ' + token);
          const command = 'install_script=$(mktemp) && curl --fail --silent --show-error --proto =http,https -H ' + header + ' ' + shellQuote(origin + '/bootstrap/install.sh') + ' -o "$install_script" && bash "$install_script" ' + shellQuote(origin) + ' ' + shellQuote(token);
          return send(res, 200, { command, expires: Date.now() + 15 * 60000, insecure: origin.startsWith('http:') });
        }
        if (route === '/api/command' && req.method === 'POST') {
          const p = await body(req); return send(res, 202, enqueue(store, p.hostId, p.action, p.args));
        }
        if (route === '/api/mqtt' && req.method === 'POST') {
          const p = await body(req);
          requireValue(typeof p.url === 'string' && p.url.length < 300, 'Endereço MQTT inválido.');
          if (p.url) {
            let parsed; try { parsed = new URL(p.url); } catch { throw new Error('URL MQTT inválida.'); }
            requireValue(['mqtt:', 'mqtts:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && ['', '/'].includes(parsed.pathname), 'Use mqtt://host:1883 ou mqtts://host:8883, sem credenciais na URL.');
          }
          requireValue(typeof p.username === 'string' && p.username.length < 200, 'Usuário inválido.');
          requireValue(p.password === undefined || typeof p.password === 'string' && p.password.length < 1000, 'Senha inválida.');
          store.state.mqtt = { url: p.url, username: p.username, password: p.password ?? (store.state.mqtt || config)?.password ?? '' };
          await bridge.connect(store.state.mqtt); store.event('mqtt', p.url ? 'Configuração MQTT atualizada.' : 'MQTT desativado.');
          return send(res, 200, { ok: true });
        }
        if (route === '/api/revoke' && req.method === 'POST') {
          const p = await body(req), host = store.state.hosts[p.hostId];
          requireValue(host, 'Host não encontrado.', 404);
          requireValue(!online(host), 'Remova o agente no host antes de revogar o vínculo.', 409);
          bridge.remove(host); host.revoked = true;
          store.event('remove', 'Vínculo revogado. Histórico de instalação preservado.', host.id);
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Rota não encontrada.' });
      }
      if (req.method === 'GET') {
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        for (const file of ['dashboard.js', 'hardware.js', 'dashboard.css']) assets['/' + file] = [file, file.endsWith('.css') ? 'text/css' : 'text/javascript'];
        if (assets[route]) {
          const [file, type] = assets[route]; return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), type);
        }
      }
      send(res, 404, { error: 'Não encontrado.' });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 400, { error: error.message });
      else res.end();
    }
  });
  const timer = setInterval(() => {
    for (const host of Object.values(store.state.hosts)) bridge.publish(host);
    for (const [key, until] of sessions) if (until < Date.now()) sessions.delete(key);
    for (const [key, item] of attempts) if (item.until < Date.now()) attempts.delete(key);
    for (const [key, item] of Object.entries(store.state.enrollments)) if (item.expires < Date.now()) delete store.state.enrollments[key];
  }, 10000).unref();
  return { server, store, bridge, async close() { clearInterval(timer); await bridge.close(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(Number(process.env.PORT || 8787), process.env.LISTEN_HOST || '0.0.0.0', () => console.log('Mac mini Controller pronto na porta ' + (process.env.PORT || 8787)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
