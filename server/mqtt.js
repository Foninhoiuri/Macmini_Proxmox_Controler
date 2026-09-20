import mqtt from 'mqtt';
import { online, enqueue, VERSION } from './core.js';

export function discovery(host, base) {
  const t = host.telemetry || {}, caps = t.capabilities || {};
  const common = {
    device: { identifiers: ['macmini_' + host.id], name: host.name, manufacturer: 'Apple', model: t.model || 'Mac mini', sw_version: t.version || VERSION },
    origin: { name: 'Mac mini Controller', sw_version: VERSION },
    availability: [{ topic: base + '/availability' }, { topic: base + '/' + host.id + '/availability' }],
    availability_mode: 'all', state_topic: base + '/' + host.id + '/state',
  };
  const items = [];
  const add = (component, key, name, props) => items.push({
    topic: 'homeassistant/' + component + '/macmini_' + host.id + '/' + key + '/config',
    payload: { ...common, unique_id: 'macmini_' + host.id + '_' + key, name, ...props },
  });
  for (const sensor of t.temperatures || []) add('sensor', 'temp_' + sensor.id, sensor.label, {
    device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement',
    value_template: '{{ value_json.temperatures["' + sensor.id + '"] }}',
  });
  for (const fan of t.fans || []) add('sensor', 'fan_' + fan.id, 'Ventoinha ' + fan.id, {
    unit_of_measurement: 'rpm', state_class: 'measurement', icon: 'mdi:fan',
    value_template: '{{ value_json.fans["' + fan.id + '"] }}',
  });
  add('binary_sensor', 'drift', 'Arquivos alterados', {
    device_class: 'problem', value_template: "{{ 'ON' if value_json.drift else 'OFF' }}", payload_on: 'ON', payload_off: 'OFF',
  });
  if (caps.fan) add('select', 'fan_profile', 'Perfil térmico', {
    options: ['automatic', 'balanced', 'cool', 'maximum'],
    command_topic: base + '/' + host.id + '/set/fan', value_template: '{{ value_json.fan_profile }}',
  });
  if (caps.cpu) add('select', 'cpu_profile', 'Perfil de energia', {
    options: ['original', 'eco', 'balanced', 'performance'],
    command_topic: base + '/' + host.id + '/set/cpu', value_template: '{{ value_json.cpu_profile }}',
  });
  for (const radio of ['wifi', 'bluetooth']) if (caps.radios && t.radios?.some(r => r.type === radio)) add('switch', radio, radio === 'wifi' ? 'Wi-Fi' : 'Bluetooth', {
    command_topic: base + '/' + host.id + '/set/' + radio,
    value_template: '{{ value_json.' + radio + ' }}', payload_on: 'ON', payload_off: 'OFF',
  });
  return items;
}

export class Bridge {
  constructor(store) {
    this.store = store; this.client = null; this.status = 'disabled'; this.error = null;
    this.base = 'macmini/' + store.state.id; this.topics = new Set();
  }
  async connect(config) {
    if (this.client) {
      if (this.client.connected) await this.client.publishAsync(this.base + '/availability', 'offline', { retain: true });
      await this.client.endAsync(); this.client = null;
    }
    this.status = 'disabled'; this.error = null; this.topics.clear();
    if (!config?.url) return;
    this.status = 'connecting';
    const client = this.client = mqtt.connect(config.url, {
      username: config.username || undefined, password: config.password || undefined,
      clientId: 'macmini-' + this.store.state.id, protocolVersion: 4,
      reconnectPeriod: 5000, connectTimeout: 8000,
      will: { topic: this.base + '/availability', payload: Buffer.from('offline'), retain: true, qos: 1 },
    });
    client.on('connect', () => {
      this.status = 'connected'; this.error = null;
      client.subscribe([this.base + '/+/set/+', 'homeassistant/status']);
      client.publish(this.base + '/availability', 'online', { retain: true, qos: 1 });
      for (const host of Object.values(this.store.state.hosts)) this.publish(host, true);
    });
    client.on('error', () => { this.error = 'Falha ao conectar. Confira endereço, credenciais e certificado do broker.'; });
    client.on('offline', () => { this.status = 'offline'; });
    client.on('message', (topic, buffer, packet) => {
      if (topic === 'homeassistant/status') {
        if (buffer.toString() === 'online') for (const host of Object.values(this.store.state.hosts)) this.publish(host, true);
        return;
      }
      if (packet.retain || buffer.length > 100) return;
      const relative = topic.slice(this.base.length + 1).split('/');
      if (!topic.startsWith(this.base + '/') || relative.length !== 3 || relative[1] !== 'set') return;
      const [hostId, , control] = relative, value = buffer.toString();
      try {
        if (control === 'fan') enqueue(this.store, hostId, 'fan.profile', { profile: value }, 'home-assistant');
        else if (control === 'cpu') enqueue(this.store, hostId, 'cpu.profile', { profile: value }, 'home-assistant');
        else if (['wifi', 'bluetooth'].includes(control) && ['ON', 'OFF'].includes(value)) enqueue(this.store, hostId, 'radio.set', { radio: control, blocked: value === 'OFF' }, 'home-assistant');
      } catch (error) { this.store.event('warning', 'Home Assistant: ' + error.message, hostId); }
    });
  }
  publish(host, force = false) {
    if (!this.client?.connected) return;
    const prefix = this.base + '/' + host.id, t = host.telemetry || {};
    this.client.publish(prefix + '/availability', online(host) ? 'online' : 'offline', { retain: true, qos: 1 });
    if (host.revoked) { this.remove(host); return; }
    const next = new Set();
    for (const item of discovery(host, this.base)) {
      next.add(item.topic);
      const key = item.topic + JSON.stringify(item.payload);
      if (force || !this.topics.has(key)) {
        this.client.publish(item.topic, JSON.stringify(item.payload), { retain: true, qos: 1 });
        this.topics.add(key);
      }
    }
    const previous = host.discoveryTopics || [];
    for (const topic of previous) if (!next.has(topic)) this.client.publish(topic, '', { retain: true, qos: 1 });
    host.discoveryTopics = [...next];
    this.client.publish(prefix + '/state', JSON.stringify({
      temperatures: Object.fromEntries((t.temperatures || []).map(s => [s.id, s.value])),
      fans: Object.fromEntries((t.fans || []).map(s => [s.id, s.rpm])),
      fan_profile: t.fanProfile || 'automatic', cpu_profile: t.cpuProfile || 'original',
      drift: Boolean(t.inventory?.some(f => ['modified', 'missing', 'unexpected'].includes(f.status))),
      wifi: t.radios?.some(r => r.type === 'wifi' && !r.blocked) ? 'ON' : 'OFF',
      bluetooth: t.radios?.some(r => r.type === 'bluetooth' && !r.blocked) ? 'ON' : 'OFF',
    }));
  }
  remove(host) {
    if (this.client?.connected) {
      for (const topic of host.discoveryTopics || []) this.client.publish(topic, '', { retain: true, qos: 1 });
      host.discoveryTopics = [];
      this.client.publish(this.base + '/' + host.id + '/availability', 'offline', { retain: true, qos: 1 });
    }
  }
  async close() {
    if (this.client?.connected) await this.client.publishAsync(this.base + '/availability', 'offline', { retain: true });
    if (this.client) await this.client.endAsync();
  }
}
