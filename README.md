# DNNS RMM Server

> Monta tu propio servidor RMM (acceso remoto SSH) para gestionar tus servidores. Acepta agentes de [`dnns-rmm-agent`](https://github.com/dnns-es/dnns-rmm-agent).

[![Licencia](https://img.shields.io/badge/licencia-gratuita-blue)]()

## 💚 Software gratuito y sin ánimo de lucro

Servicio de mantenimiento remoto **100% gratuito**. No hay versión de pago. Móntalo en tu propia infraestructura y gestiona tus servidores tú mismo.

---

## ¿Qué hace?

```
┌────────────────┐    SSH inverso (puerto 2222)    ┌───────────────┐
│ Server cliente │ ─────────────────────────────►  │ TÚ (RMM)      │
│ (con agente)   │                                 │ - sshd:2222   │
│ autossh -R     │  ◄──── tu SSH al cliente ────── │ - API :3001   │
└────────────────┘    (vía puerto reservado)       └───────────────┘
```

1. Instalas este `dnns-rmm-server` en tu CT/VPS
2. Apuntas un dominio al server (`rmm.tudominio.com`)
3. Tus servidores cliente instalan `dnns-rmm-agent` apuntando a tu dominio
4. Los agentes se registran → recibes `tunnel-N` user + puerto único
5. Conectas vía SSH a tus clientes haciendo `ssh root@127.0.0.1 -p 4000X` desde tu RMM server

---

## Instalación

En un servidor Debian 12 limpio (root):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dnns-es/dnns-rmm-server/main/install.sh)
```

Instala:
- Node.js 20 + API minimalista
- sshd dedicado en puerto 2222 (con `GatewayPorts clientspecified`)
- Servicio systemd `dnns-rmm-server`
- Firewall UFW configurado

Tiempo: **2-3 min**.

---

## Variables de entorno (opcionales)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PUERTO_SSHD` | `2222` | Puerto del sshd que recibe túneles |
| `PUERTO_API` | `3001` | Puerto de la API (solo localhost) |
| `RANGO_TUNNEL_MIN` | `40000` | Inicio rango puertos para túneles |
| `RANGO_TUNNEL_MAX` | `40999` | Fin rango puertos para túneles |
| `INSTALL_DIR` | `/opt/dnns-rmm-server` | Carpeta del código |
| `DATA_DIR` | `/var/lib/dnns-rmm-server` | Datos persistentes |

Ejemplo personalizando:
```bash
PUERTO_SSHD=2023 RANGO_TUNNEL_MIN=50000 RANGO_TUNNEL_MAX=50500 \
  bash <(curl -fsSL .../install.sh)
```

---

## API REST

Toda la API escucha **solo en localhost (`127.0.0.1`)** por seguridad. Si quieres exponerla, proxéala con NPM/Caddy con auth.

### `GET /api/salud`
Healthcheck.
```json
{ "ok": true, "servicio": "dnns-rmm-server", "agentes": 5 }
```

### `POST /api/agentes/registrar`
Registro de un agente.

Request:
```json
{
  "hostname": "miserver-abc123",
  "ct_ip": "192.168.1.50",
  "hw_id": "sha256-32-chars",
  "agent_pubkey": "ssh-ed25519 AAAA...",
  "producto": "generic",
  "version": "generic-1.0",
  "admin_email": "admin@ejemplo.es",
  "admin_name": "Tu Nombre",
  "dominio": "miapp.ejemplo.es"
}
```

Response:
```json
{ "ok": true, "user": "tunnel-9", "port": 40009, "reuso": false }
```

Si el `hw_id` ya existe → reuso (mismo user/port, actualiza metadata).

### `POST /api/agentes/heartbeat`
Mantiene el agente como "online".

### `GET /api/agentes`
Lista agentes registrados (debug). **Recomendado proteger con auth en producción.**

---

## Conectar a un servidor cliente

Una vez registrado un agente y con el túnel activo:

```bash
# Desde tu RMM server (donde está sshd:2222)
ssh root@127.0.0.1 -p 40009  # 40009 = puerto del agente
```

O usa la **UI web admin** incluida (`/login`) que ya muestra la lista de agentes con botones de **Consola web** (xterm.js + WebSocket SSH), **SSH** (copiar comando), **Cambiar puerto** y **Borrar**.

---

## Persistencia

Los agentes registrados se guardan en `/var/lib/dnns-rmm-server/agentes.json` (mismo formato que envías). Backup:

```bash
cp /var/lib/dnns-rmm-server/agentes.json /backup/agentes-$(date +%F).json
```

Si pierdes el JSON, los agentes se re-registran al siguiente heartbeat (asignándoles **nuevo** puerto).

---

## Seguridad

- Usuario `tunnel-N` con `nologin` shell + restricciones SSH (`no-pty`, `no-X11`, `no-agent`, `command="..."`)
- Solo permite port forwarding inverso (no shell ni ejecución)
- Firewall UFW abre 22 (admin), `PUERTO_SSHD` (RMM), rango túneles
- API expuesta SOLO en `127.0.0.1` (proxéala si necesitas público con auth)

**No expongas el `PUERTO_API` directamente a internet.** Usa NPM/Caddy con auth básica o JWT.

---

## Licencia

Gratuita, sin ánimo de lucro. Ver [LICENSE](LICENSE).

## Soporte

- Email: `info@dnns.es`
- Issues: GitHub Issues
