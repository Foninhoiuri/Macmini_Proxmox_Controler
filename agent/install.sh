#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo "Execute no Shell do nó Proxmox, como root."; exit 1; }
[[ -f /etc/pve/.version || -d /etc/pve ]] || { echo "Este instalador é para o host Proxmox, não o LXC."; exit 1; }
if systemd-detect-virt --container --quiet; then echo "Execute no host físico, não no contêiner."; exit 1; fi
[[ $# -eq 2 ]] || { echo "Use o comando gerado no painel."; exit 1; }
for tool in python3 curl systemctl sha256sum install; do
  command -v "$tool" >/dev/null || { echo "Dependência ausente: $tool. Instale manualmente antes de continuar."; exit 1; }
done
for target in /opt/macmini-controller /etc/macmini-controller /var/lib/macmini-controller /etc/systemd/system/macmini-controller.service /etc/modules-load.d/macmini-controller.conf; do
  [[ ! -L "$target" ]] || { echo "Link simbólico inesperado: $target"; exit 1; }
done
[[ ! -e /opt/macmini-controller && ! -e /etc/macmini-controller && ! -e /etc/systemd/system/macmini-controller.service && ! -e /etc/modules-load.d/macmini-controller.conf && ! -e /var/lib/macmini-controller ]] || {
  echo "Instalação ou dados existentes encontrados. Consulte o inventário; use o desinstalador antes de parear novamente."; exit 1;
}
controller_url="$1"
enrollment_token="$2"
export controller_url enrollment_token
python3 - <<'PY'
import os
from urllib.parse import urlsplit
p = urlsplit(os.environ["controller_url"])
assert p.scheme in ("http", "https") and p.hostname and not p.username and not p.password and not p.query and not p.fragment and p.path in ("", "/"), "URL inválida"
assert len(os.environ["enrollment_token"]) == 64, "Token inválido"
PY
if [[ "$controller_url" == http:* ]]; then echo "Conexão HTTP: utilize somente sua rede local confiável/VPN. Configure HTTPS para tráfego em outras redes."; fi
stage_dir="$(mktemp -d)"
trap 'rm -rf -- "$stage_dir"' EXIT
for asset in agent.py uninstall.sh macmini-controller.service; do
  curl --fail --silent --show-error --proto '=http,https' --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $enrollment_token" "$controller_url/bootstrap/$asset" -o "$stage_dir/$asset"
done
printf '%s  %s\n' '@@SHA_agent.py@@' "$stage_dir/agent.py" '@@SHA_uninstall.sh@@' "$stage_dir/uninstall.sh" '@@SHA_macmini-controller.service@@' "$stage_dir/macmini-controller.service" | sha256sum --check --status
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$stage_dir/agent.py"
install -d -m 700 /opt/macmini-controller /etc/macmini-controller /var/lib/macmini-controller
install -m 600 "$stage_dir/agent.py" /opt/macmini-controller/agent.py
install -m 700 "$stage_dir/uninstall.sh" /opt/macmini-controller/uninstall.sh
install -m 644 "$stage_dir/macmini-controller.service" /etc/systemd/system/macmini-controller.service
printf '%s\n' 'applesmc' > /etc/modules-load.d/macmini-controller.conf
python3 - <<'PY'
import json, os
with open("/etc/macmini-controller/agent.json", "w") as f:
    json.dump({"url": os.environ["controller_url"], "token": os.environ["enrollment_token"]}, f)
os.chmod("/etc/macmini-controller/agent.json", 0o600)
PY
unset enrollment_token
modprobe applesmc 2>/dev/null || true
echo "Pareando agente..."
if ! python3 -B /opt/macmini-controller/agent.py --enroll; then
  echo "Pareamento falhou. Arquivos estão registrados em /opt/macmini-controller."
  echo "Para remover: bash /opt/macmini-controller/uninstall.sh"
  exit 1
fi
python3 -B /opt/macmini-controller/agent.py --manifest
systemctl daemon-reload
systemctl enable --now macmini-controller.service
systemctl is-active --quiet macmini-controller.service
echo "Agente instalado. Volte ao painel; a conexão deve aparecer em alguns segundos."
echo "Status: systemctl status macmini-controller"
echo "Logs: journalctl -u macmini-controller -n 100"
echo "Remover: bash /opt/macmini-controller/uninstall.sh"
