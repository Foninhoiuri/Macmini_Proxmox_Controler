#!/usr/bin/env bash
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Execute como root no host Proxmox."; exit 1; }
for target in /opt/macmini-controller /etc/macmini-controller /var/lib/macmini-controller; do
  [[ ! -L "$target" ]] || { echo "Caminho simbólico inesperado: $target. Remoção interrompida."; exit 1; }
done
[[ ! -L /etc/systemd/system/macmini-controller.service ]] || { echo "Serviço é um link inesperado."; exit 1; }
[[ ! -L /etc/modules-load.d/macmini-controller.conf ]] || { echo "Configuração de módulo é um link inesperado."; exit 1; }
echo "Parando agente e restaurando ventoinha, CPU, rádios e USB..."
systemctl stop macmini-controller.service || true
if [[ -f /opt/macmini-controller/agent.py ]]; then
  python3 -B /opt/macmini-controller/agent.py --restore || {
    echo "Não foi possível restaurar todos os ajustes. Os arquivos foram preservados. Consulte /var/lib/macmini-controller/original.json."; exit 1;
  }
fi
systemctl disable macmini-controller.service 2>/dev/null || true
backup="/var/backups/macmini-controller-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup"
for target in /opt/macmini-controller /etc/macmini-controller /var/lib/macmini-controller; do
  if [[ -e "$target" ]]; then
    case "$target" in
      /opt/macmini-controller) mv -- "$target" "$backup/code" ;;
      /etc/macmini-controller) mv -- "$target" "$backup/config" ;;
      /var/lib/macmini-controller) mv -- "$target" "$backup/state" ;;
    esac
  fi
done
if [[ -f /etc/systemd/system/macmini-controller.service ]]; then mv -- /etc/systemd/system/macmini-controller.service "$backup/"; fi
if [[ -f /etc/modules-load.d/macmini-controller.conf ]]; then mv -- /etc/modules-load.d/macmini-controller.conf "$backup/"; fi
systemctl daemon-reload
systemctl reset-failed macmini-controller.service 2>/dev/null || true
echo "Agente removido. Backup recuperável (contém credencial): $backup"
echo "No painel, revogue o vínculo para invalidar a credencial e remover as entidades MQTT."
echo "Nenhum pacote do sistema foi removido. O histórico do painel foi preservado."
