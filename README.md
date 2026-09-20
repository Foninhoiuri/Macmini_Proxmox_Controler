# Mini Control

Painel local para o hardware de um **Mac mini Intel com Proxmox**, com instalação rastreável e integração MQTT com o Home Assistant.

O painel roda em Docker dentro do LXC. Um agente Python roda diretamente no host Proxmox, lê os sensores e executa apenas ações previstas. O agente não abre portas: conecta-se ao painel a cada 5 segundos.

## Comece pelo Docker no LXC

Requisitos: Docker Engine + Compose no LXC, saída de rede para baixar a imagem/dependências durante o build, e um endereço que o host Proxmox consiga acessar. Este projeto não instala nem reconfigura o Docker.

Copie esta pasta para o LXC. Na pasta do projeto:

```bash
cp .env.example .env
openssl rand -hex 32
nano .env
```

Cole a chave gerada em `ADMIN_TOKEN`. Defina `HOST_ADDRESS` como o IP do **LXC** e escolha a porta em `PORT`, por exemplo:

```dotenv
ADMIN_TOKEN=sua_chave_aleatoria_gerada_acima
HOST_ADDRESS=192.168.1.100
PORT=8787
PUBLIC_URL=http://${HOST_ADDRESS}:${PORT}
BIND_IP=0.0.0.0
REQUIRE_HTTPS=0
```

Não use literalmente a chave do exemplo. Inicie:

```bash
docker compose up -d --build
docker compose logs -f --tail=100
```

Abra `http://IP-DO-LXC:8787`, entre com a ADMIN_TOKEN e acesse **Instalação e arquivos**.

O container não precisa de modo privilegiado, acesso ao Docker socket, montagem de /sys nem acesso ao disco do host. Usa usuário sem privilégios, volume nomeado, sistema de arquivos somente leitura e 256 MB de limite.

**Teste sem hardware:** na tela de login, “Explorar demonstração” mostra dados explicitamente ilustrativos. Nenhuma ação nesse modo é enviada ao Mac.

## Implantar pelo Portainer

O arquivo padrão `docker-compose.yml` é próprio para **Portainer com Docker Swarm**. Ele usa a imagem pronta `ghcr.io/foninhoiuri/macmini_proxmox_controler:latest`, sem build no servidor, restart ou security_opt incompatíveis com Swarm. Crie ou atualize a stack usando **Repository**:

- Repository URL: `https://github.com/Foninhoiuri/Macmini_Proxmox_Controler`
- Repository reference: `refs/heads/main`
- Compose path: `docker-compose.yml` (arquivo na raiz, sem `/data/compose/...`)

Para **Docker Standalone com build local**, use `compose.yaml`. Os arquivos têm finalidades diferentes; escolha apenas um, sem adicioná-los juntos como arquivos complementares. Ambos usam `deploy.resources.limits.memory` para o limite de 256 MB.

Cada alteração de código na main inicia o workflow **Testar e publicar imagem**, que roda os testes, valida a stack, constrói a imagem Linux amd64 (Mac Intel), testa o container com volume persistente e publica no GitHub Container Registry. Aguarde o workflow ficar verde antes de implantar.

**Primeira publicação:** o GitHub cria pacotes de container privados por padrão. Abra o pacote **macmini_proxmox_controler → Package settings → Change visibility → Public** para o Portainer baixar sem credenciais. Isso é independente da visibilidade pública do repositório. Se preferir manter a imagem privada, configure no Portainer um registro `ghcr.io` com seu usuário GitHub e um token clássico com `read:packages`; não use ADMIN_TOKEN para autenticar no registro.

Nas variáveis da stack, informe:

```dotenv
ADMIN_TOKEN=cole_a_chave_do_seu_env_local
PORT=8787
PUBLIC_URL=http://192.168.1.200:8787
```

Use a chave real do seu arquivo local. O `.env` não está no GitHub e precisa ser importado ou preenchido no Portainer. Na interface, prefira o valor completo de PUBLIC_URL, sem depender de interpolação entre variáveis. Se escolher outra porta em PORT, ajuste também a porta em PUBLIC_URL.

Após atualizar o repositório, solicite ao Portainer a atualização/reimplantação da stack a partir do Git. Se receber “docker-compose.yml: no such file”, confira o **Compose path** e se a revisão mais recente foi baixada. Não é necessário criar manualmente o diretório interno `/data/compose/41`.

A stack usa uma única réplica no nó manager e atualização stop-first, para impedir dois processos escrevendo no mesmo volume. A porta é publicada no próprio nó que executa o serviço. O `BIND_IP` se aplica apenas ao Compose standalone; no Swarm controle o acesso pela rede/firewall.

Em um Swarm com vários managers, acrescente uma restrição `node.hostname == NOME_DO_SEU_NO` para manter o serviço no nó que contém o volume local, ou prepare armazenamento compartilhado antes de permitir movimentação. Esta configuração pressupõe seu LXC como único manager.

Para fixar uma versão, configure a variável `CONTROLLER_IMAGE` com a tag `ghcr.io/foninhoiuri/macmini_proxmox_controler:sha-COMMIT_COMPLETO` mostrada no resumo do workflow. A tag `latest` só muda depois dos testes e publicação bem-sucedidos.

## Escolher as portas de comunicação

| Configuração | O que define |
|---|---|
| `HOST_ADDRESS` | IP ou domínio do LXC |
| `PORT` | Porta externa do painel, API e conexão do agente; padrão 8787 |
| `PUBLIC_URL` | Montada a partir de HOST_ADDRESS e PORT; pode ser substituída pela URL de um proxy HTTPS |
| `MQTT_URL` | Endereço e porta independentes do broker, por exemplo `mqtt://192.168.1.50:1883` |
| `BIND_IP` | IP do LXC onde publicar a porta; 0.0.0.0 permite suas interfaces |

Para usar a porta 8790, mude apenas `PORT=8790` e execute `docker compose up -d`. Acesse `http://IP-DO-LXC:8790`. A porta interna do container continua em 8787; o Compose encaminha a porta escolhida para ela.

O agente usa a mesma porta HTTP(S) do painel, com rotas e credencial próprias, e não abre porta de entrada no Proxmox. MQTT é uma conexão de saída para o broker; não precisa publicar outra porta neste container. Você pode alterar o endereço e a porta MQTT em **Home Assistant** no painel.

Escolha a porta antes de parear. Se mudar a URL depois, atualize `url` em `/etc/macmini-controller/agent.json` no host e execute `systemctl restart macmini-controller`. Atualize também a URL na tela de instalação para futuros pareamentos. A alteração intencional da configuração será sinalizada no inventário.

O `.env` local contém sua chave e não vai para o GitHub. Depois de clonar o repositório no LXC, transfira esse arquivo local de forma privada ou crie outro usando `.env.example`.

## Instale o agente pelo painel

1. Em **Instalação e arquivos**, informe a URL do painel acessível pelo Proxmox.
2. Gere o comando de instalação. Ele vale por 15 minutos e o pareamento só pode ser consumido uma vez.
3. No Proxmox, selecione o **nó físico → Shell**, como root, e execute o comando.
4. O instalador verifica que está no host, verifica os hashes dos arquivos, cria o serviço e pareia o agente.
5. O painel habilita os controles conforme os recursos realmente detectados.

O host precisa de Python 3.10+, curl, systemd e utilitários básicos Debian. Esses componentes normalmente já existem no Proxmox. O instalador informa dependências ausentes; **não instala pacotes**. Para controle de volume, `alsa-utils` é opcional e deve ser instalado por você.

No modo HTTP, credenciais passam sem criptografia: use apenas LAN confiável/VPN. Para redes não confiáveis, publique o painel por proxy HTTPS, configure `PUBLIC_URL=https://...` e `REQUIRE_HTTPS=1`. O agente verifica os certificados e não segue redirecionamentos com a credencial.

## O que funciona nesta versão

| Área | Implementação |
|---|---|
| SMC | Sensores Intel applesmc/coretemp; caminhos hwmon modernos e antigos; RPM e limites de ventoinha |
| Resfriamento | Automático, equilibrado, resfriar e máximo por 5 minutos |
| CPU física | Intel P-state: original, econômico, equilibrado e desempenho |
| Rádios | Ativar/desativar Wi-Fi e Bluetooth detectados em rfkill |
| USB | Autosuspend em periféricos permitidos; armazenamento, hubs e classes de rede protegidos |
| Áudio | Volume do controle ALSA Master ou Speaker, se disponível |
| Arquivos | Hash dos arquivos instalados; ausentes, alterados e entradas inesperadas nas pastas do agente |
| Auditoria | Origem painel/Home Assistant, fila, execução confirmada, falha, expiração e resultado desconhecido |
| Home Assistant | MQTT Discovery, sensores, seletores de perfis, interruptores dos rádios, integridade e disponibilidade |
| Remoção | Restaura ajustes capturados, desativa o serviço e move arquivos para backup recuperável |

Sem infravermelho, conforme o escopo do projeto. Sem métricas genéricas de CPU/RAM/disco, gerenciamento de VMs/LXCs ou duplicação do painel Proxmox.

**Diagnóstico, sem comando de escrita nesta versão:** estados de suspensão, presença de alarme RTC, EFI e powercap. **Ainda não implementados:** WoL configurável, suspensão/agendamento RTC, retorno após falta de energia, edição EFI, APM/spindown de discos, limites RAPL e controle de HDMI/LED. Não são anunciados como funcionais: dependem de verificação do hardware/firmware real e alguns exigem testes com acesso físico. Um Mac travado não pode ser recuperado pelo próprio agente.

## Resfriamento e restauração

- O agente eleva `fan*_min` e mantém o modo automático do SMC, permitindo ao firmware solicitar uma rotação maior. Não reduz abaixo do mínimo capturado.
- Equilibrado sobe gradualmente entre 45–78 °C; resfriar entre 40–70 °C. A referência é o maior sensor válido identificado.
- Sem sensores ou acima de 85 °C, os perfis controlados solicitam a rotação máxima. **Modo automático delega ao firmware e não impõe essa curva.**
- Máximo expira localmente em cinco minutos e retorna ao equilibrado.
- A curva roda em uma tarefa local independente da comunicação com o painel.
- O serviço tenta restaurar os valores originais ao encerrar, no próximo início e no ExecStopPost.
- Não há garantia de restauração diante de travamento completo do kernel, falha física ou SMC que rejeite a escrita. Não há desligamento térmico personalizado nesta versão.
- O agente recusa assumir a curva se detectar mbpfan, macfanctld, macfanpp ou fancontrol ativos. Não os desinstala nem desativa.
- Perfis não persistem entre reinícios do agente: ele começa com os valores restaurados. O Home Assistant pode reaplicar uma automação quando o dispositivo voltar.

Valide inicialmente as temperaturas e RPM com o perfil automático. O hardware real ainda não foi testado neste desenvolvimento.

## Onde fica cada componente

| Caminho no host Proxmox | Conteúdo |
|---|---|
| `/opt/macmini-controller/agent.py` | Agente Python sem dependências de pip |
| `/opt/macmini-controller/uninstall.sh` | Desinstalador |
| `/etc/macmini-controller/agent.json` | URL e credencial do agente, acesso root |
| `/var/lib/macmini-controller/manifest.json` | Inventário de instalação e hashes |
| `/var/lib/macmini-controller/original.json` | Ajustes capturados antes das alterações |
| `/var/lib/macmini-controller/audio-original.json` | Volume original, criado se houver ajuste |
| `/etc/systemd/system/macmini-controller.service` | Serviço systemd |
| `/etc/modules-load.d/macmini-controller.conf` | Carregamento do módulo applesmc no boot |
| journal do systemd | Logs do agente |

O inventário verifica os arquivos registrados e percorre as pastas de programa/configuração a cada 30 segundos, sem seguir links simbólicos de diretórios. Limita o relatório a 299 entradas. Não monitora todo o host nem descobre automaticamente instalações de outros projetos. A credencial não é enviada; apenas caminho, tamanho e resultado da comparação de hash. O inventário reside no próprio host, portanto não é um mecanismo contra invasão de root.

No Docker, a configuração, credenciais de integração, histórico (24 h, amostras de 30 s) e eventos ficam no volume `controller-data`, montado em `/data`. Faça backup desse volume.

## Home Assistant

1. Configure a integração MQTT no Home Assistant e seu broker, por exemplo Mosquitto.
2. No Mini Control → **Home Assistant**, informe o mesmo endereço, usuário e senha de um usuário autorizado no broker.
3. O dispositivo e entidades aparecem automaticamente conforme o hardware identificado.

O cliente do painel usa MQTT 3.1.1, suportado pelos brokers Mosquitto usados com HA; não exige que o próprio Home Assistant use a mesma versão do protocolo.

Descoberta: `homeassistant/...`. Dados e comandos: `macmini/ID_DO_PAINEL/ID_DO_HOST/...`. A interface gera um exemplo YAML com os tópicos reais.

Credenciais ficam apenas no volume do painel, não retornam em texto ao navegador. Use um usuário MQTT dedicado; autorize publicação de descoberta e estados e assinatura dos tópicos de comando e `homeassistant/status`. MQTT com TLS (`mqtts://`) exige certificado confiável; certificados próprios podem ser adicionados com `NODE_EXTRA_CA_CERTS` e uma montagem somente leitura.

Discovery é retido e reenviado quando HA anuncia inicialização. Disponibilidade combina painel conectado ao broker e agente com contato nos últimos 35 segundos. Comandos precisam de agente online, expiram em 20 segundos e não são reenviados cegamente. Não publique comandos retidos.

## Remover e atualizar

**Remover o agente, no Shell do host Proxmox:**

```bash
bash /opt/macmini-controller/uninstall.sh
```

O desinstalador para o serviço, restaura os ajustes, remove o início automático e move programa/configuração/estado para `/var/backups/macmini-controller-AAAAmmdd-HHMMSS`. Se a restauração falhar, preserva os arquivos e informa o motivo. O backup contém a antiga credencial; proteja-o.

Depois que o agente ficar offline, clique em **Revogar vínculo após remoção**. Isso invalida o token e remove a descoberta MQTT, preservando o histórico. Revogar o vínculo não é prova de desinstalação física: execute o comando antes.

**Atualizar o painel, no LXC:** copie os arquivos novos para a pasta e execute `docker compose up -d --build`. O volume nomeado persiste.

**Atualizar o agente v0.1:** desinstale pelo comando acima, revogue o vínculo antigo e gere uma instalação nova pelo painel. A nova instalação recebe outro ID e entidades HA novas; revise suas automações. Não há atualização silenciosa nem execução de código novo a partir de mudanças de pasta.

**Parar/remover o painel:** `docker compose down` preserva seus dados. O agente deve ser removido antes se você não pretende manter seu funcionamento local. Não use `down -v` se quiser preservar o histórico/configuração.

## Diagnóstico

No host:

```bash
systemctl status macmini-controller
journalctl -u macmini-controller -n 100 --no-pager
python3 -B /opt/macmini-controller/agent.py --inspect
```

No LXC:

```bash
docker compose ps
docker compose logs --tail=100
curl -f http://127.0.0.1:8787/healthz
```

Se a instalação parou antes de iniciar o serviço, o instalador informa os diretórios criados. O desinstalador também pode remover essa instalação parcial.

## Desenvolvimento e verificações

Node.js 22+:

```bash
npm ci
npm test
python3 -B -m unittest discover -s tests -p test_agent.py -v
npm start
```

Sem ADMIN_TOKEN no desenvolvimento, a chave é criada em `data/admin-token.txt`; abra o arquivo local para entrar. A porta padrão é 8787.

Verificação visual opcional:

```bash
npx playwright install chromium
node tests/browser.mjs
```

Os testes cobrem API, autorização, expiração, pareamento, MQTT com broker real de teste, fallback térmico em sysfs simulado, restauração, USB protegido, detecção de alterações, interface desktop e celular.

**Situação de validação:** testes de software executados localmente; imagem Docker e instalação no Proxmox real não executadas, conforme solicitado. Não é uma validação física da ventoinha nem do firmware.

## Referências de implementação

- [MQTT Discovery do Home Assistant](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery)
- [Driver applesmc Linux](https://github.com/torvalds/linux/blob/master/drivers/hwmon/applesmc.c)
- [Intel P-state](https://docs.kernel.org/admin-guide/pm/intel_pstate.html)
- [Gerenciamento USB](https://docs.kernel.org/driver-api/usb/power-management.html)

Veja [docs/API.md](docs/API.md) para a interface HTTP.
