# API HTTP e protocolo do agente

Todas as rotas administrativas usam `Authorization: Bearer ADMIN_TOKEN` ou sessão HttpOnly emitida pelo login. A sessão dura 12 horas, SameSite=Strict. A API não oferece CORS. Requisições com Origin externo são recusadas.

| Método e rota | Uso |
|---|---|
| GET /healthz | Saúde e versão, sem autenticação |
| POST /api/login | JSON token → sessão |
| POST /api/logout | Encerra sessão |
| GET /api/state | Hosts, telemetria, histórico, auditoria e configuração MQTT sem senha |
| POST /api/pair | JSON url → comando de instalação, validade 15 min |
| POST /api/command | JSON hostId, action, args → comando na fila |
| POST /api/mqtt | JSON url, username, password; omitir senha mantém atual; URL vazia desconecta |
| POST /api/revoke | JSON hostId; exige host offline; invalida vínculo e discovery |
| GET /bootstrap/install.sh | Credencial de pareamento válida |
| GET /bootstrap/agent.py | Credencial de pareamento válida |
| GET /bootstrap/uninstall.sh | Credencial de pareamento válida |
| GET /bootstrap/macmini-controller.service | Credencial de pareamento válida |
| POST /agent/enroll | Credencial de pareamento; JSON name; retorna id e token exclusivos do agente |
| POST /agent/heartbeat | Credencial do agente; JSON telemetry e results; retorna comandos |

Ações administrativas suportadas:

```json
{"hostId":"ID","action":"fan.profile","args":{"profile":"cool"}}
{"hostId":"ID","action":"cpu.profile","args":{"profile":"eco"}}
{"hostId":"ID","action":"radio.set","args":{"radio":"bluetooth","blocked":false}}
{"hostId":"ID","action":"usb.autosuspend","args":{"id":"1-2","mode":"auto"}}
{"hostId":"ID","action":"audio.volume","args":{"volume":30}}
```

Perfis térmicos: automatic, balanced, cool, maximum.
Perfis CPU: original, eco, balanced, performance.
USB: on (sempre ativo) ou auto. IDs devem ser detectados e permitidos pelo agente.

A validação é feita no painel e novamente no agente. Nenhuma rota aceita shell livre, escrita em caminho arbitrário, reboot ou remoção remota. Comandos para agente offline são recusados, e filas não sobrevivem como ações executáveis a reinícios do painel.

Estados de comando: queued → sent → done/failed. Antes do envio, vencimento resulta em expired. Depois do envio, sem confirmação resulta em unknown: o comando pode ter sido aplicado; consulte a telemetria. Reiniciar o painel converte sent/queued em interrupted. Essa política evita reaplicar ações sem saber o que ocorreu.

Telemetria e estado são consultados a cada 5 s pelo navegador. Histórico é gravado a cada 30 s, até 24 h; eventos: últimos 300, comandos: últimos 200. O arquivo JSON persistente é escrito por substituição atômica. Esta edição é para um processo do painel; não execute múltiplas réplicas compartilhando o mesmo volume.

O agente confia no controlador pareado. Proteja a ADMIN_TOKEN e o volume de dados. A credencial do agente não autoriza acesso administrativo nem outro host.
