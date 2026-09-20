// Keep raw SMC readings visible: disagreement is not proof of a faulty sensor.
export function thermalAssessment(telemetry = {}) {
  const readings = (telemetry.temperatures || []).filter(s => Number.isFinite(s.value));
  const cpu = readings.filter(s => s.driver === 'coretemp' || s.label?.startsWith('coretemp'));
  const smc = readings.filter(s => s.driver === 'applesmc' || s.label?.startsWith('applesmc'));
  const cpuTemperature = cpu.length ? Math.max(...cpu.map(s => s.value)) : null;
  const unverified = cpuTemperature === null ? [] : smc.filter(s => s.value >= 85 && s.value - cpuTemperature >= 30);
  return { cpuTemperature, unverified, needsReview: unverified.length > 0 };
}

export const terminalStatuses = new Set(['done', 'failed', 'expired', 'unknown', 'interrupted']);
export function commandOutcome(command) {
  const name = ({ 'fan.profile': 'Resfriamento', 'cpu.profile': 'Energia', 'radio.set': 'Rádio', 'usb.autosuspend': 'USB', 'audio.volume': 'Volume' })[command.action] || command.action;
  const result = ({ done: 'aplicado', failed: 'falhou', expired: 'expirou sem executar', unknown: 'sem confirmação — confira o estado antes de tentar novamente', interrupted: 'interrompido — resultado não confirmado' })[command.status];
  return { kind: command.status === 'done' ? 'success' : 'error', message: `${name}: ${result}.${command.message ? ' ' + command.message : ''}` };
}
