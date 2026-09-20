import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { thermalAssessment } from '../public/hardware.js';

export const VERSION = '0.2.0';
export const secret = () => crypto.randomBytes(32).toString('hex');
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function matches(value, digest) {
  if (typeof value !== 'string' || typeof digest !== 'string') return false;
  return crypto.timingSafeEqual(Buffer.from(hash(value)), Buffer.from(digest));
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function publicUrl(value, requireHttps = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL inválida. Use o endereço acessível do LXC.'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use uma URL HTTP(S) sem caminho ou credenciais.');
  requireValue(!requireHttps || url.protocol === 'https:', 'HTTPS obrigatório nesta instalação.');
  return url.origin;
}
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const online = host => Boolean(host && !host.revoked && Date.now() - host.seen < 35000);

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'controller.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      id: crypto.randomUUID(), hosts: {}, enrollments: {}, commands: [], events: [], history: {}, mqtt: null,
    };
    // Never replay a command whose outcome was lost on restart.
    for (const cmd of this.state.commands) if (['queued', 'sent'].includes(cmd.status)) cmd.status = 'interrupted';
    this.save();
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  event(kind, message, hostId = null) {
    this.state.events.unshift({ id: crypto.randomUUID(), at: Date.now(), kind, message, hostId });
    this.state.events = this.state.events.slice(0, 300);
    this.save();
  }
}

export function validateAction(action, args, telemetry) {
  requireValue(args && typeof args === 'object' && !Array.isArray(args), 'Argumentos inválidos.');
  const caps = telemetry?.capabilities || {};
  const choice = (values, key = 'profile') => requireValue(values.includes(args[key]), 'Opção inválida.');
  switch (action) {
    case 'fan.profile':
      requireValue(caps.fan, 'Controle da ventoinha não disponível.');
      choice(['automatic', 'balanced', 'cool', 'maximum']);
      requireValue(!['balanced', 'cool'].includes(args.profile) || !thermalAssessment(telemetry).needsReview, 'Leituras térmicas divergentes: valide os sensores antes de ativar uma curva. O controlador atual foi preservado.', 409);
      return { profile: args.profile };
    case 'cpu.profile':
      requireValue(caps.cpu, 'Controle Intel P-state não disponível.');
      choice(['original', 'eco', 'balanced', 'performance']);
      return { profile: args.profile };
    case 'radio.set':
      requireValue(caps.radios && ['wifi', 'bluetooth'].includes(args.radio) && typeof args.blocked === 'boolean', 'Rádio ou estado inválido.');
      requireValue(telemetry.radios?.some(r => r.type === args.radio), 'Rádio não detectado.');
      return { radio: args.radio, blocked: args.blocked };
    case 'usb.autosuspend':
      requireValue(caps.usb && typeof args.id === 'string' && telemetry.usb?.some(d => d.id === args.id && d.controllable), 'USB indisponível ou protegido.');
      choice(['auto', 'on'], 'mode');
      return { id: args.id, mode: args.mode };
    case 'audio.volume':
      requireValue(caps.audio && Number.isInteger(args.volume) && args.volume >= 0 && args.volume <= 100, 'Volume inválido ou áudio indisponível.');
      return { volume: args.volume };
    default: throw Object.assign(new Error('Ação não permitida.'), { status: 400 });
  }
}

export function enqueue(store, hostId, action, args, source = 'panel') {
  const host = store.state.hosts[hostId];
  requireValue(online(host), 'Agente offline. O comando não será guardado para executar depois.', 409);
  const clean = validateAction(action, args, host.telemetry);
  requireValue(store.state.commands.filter(c => c.hostId === hostId && ['queued', 'sent'].includes(c.status)).length < 10, 'Aguarde os comandos pendentes.', 429);
  const cmd = { id: crypto.randomUUID(), hostId, action, args: clean, source, at: Date.now(), expires: Date.now() + 20000, status: 'queued' };
  store.state.commands.unshift(cmd);
  store.state.commands = store.state.commands.slice(0, 200);
  store.event('command', `${action}: ${JSON.stringify(clean)} (${source})`, hostId);
  return cmd;
}
