#!/bin/bash
# DNNS RMM Server - Instalador one-liner
# Monta tu propio server RMM (sshd + API) en cualquier Debian 12.
# Software gratuito sin animo de lucro.
#
# Uso:
#   bash <(curl -fsSL https://raw.githubusercontent.com/dnns-es/dnns-rmm-server/main/install.sh)
#
# Variables opcionales:
#   PUERTO_SSHD       (default 2222)
#   PUERTO_API        (default 3001, solo localhost)
#   RANGO_TUNNEL_MIN  (default 40000)
#   RANGO_TUNNEL_MAX  (default 40999)

set -e

REPO_URL="${REPO_URL:-https://github.com/dnns-es/dnns-rmm-server}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/dnns-rmm-server}"
DATA_DIR="${DATA_DIR:-/var/lib/dnns-rmm-server}"
PUERTO_SSHD="${PUERTO_SSHD:-2222}"
PUERTO_API="${PUERTO_API:-3001}"
RANGO_TUNNEL_MIN="${RANGO_TUNNEL_MIN:-40000}"
RANGO_TUNNEL_MAX="${RANGO_TUNNEL_MAX:-40999}"

G=$'\e[0;32m'; Y=$'\e[1;33m'; R=$'\e[0;31m'; N=$'\e[0m'
msg()  { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!!!%s %s\n' "$Y" "$N" "$*"; }
err()  { printf '%sXXX%s %s\n' "$R" "$N" "$*"; exit 1; }

[ "$(id -u)" = "0" ] || err "Ejecuta como root"

echo ""
printf '%s\n' "$G"
echo "========================================================="
echo "         DNNS RMM SERVER - Instalador"
echo "========================================================="
printf '%s' "$N"
cat <<BANNER
Este script instala:
 - sshd dedicado en puerto ${PUERTO_SSHD} (recibe tuneles inversos)
 - API Node.js en localhost:${PUERTO_API} (registro de agentes)
 - Rango de puertos ${RANGO_TUNNEL_MIN}-${RANGO_TUNNEL_MAX} para tuneles
 - Datos persistentes en ${DATA_DIR}/agentes.json
 - Servicio systemd dnns-rmm-server

Software gratuito sin animo de lucro.
BANNER
echo ""

# --- 1. Sistema base ---
msg "Actualizando sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl wget ca-certificates gnupg ufw fail2ban openssh-server openssl

# --- 2. Node 20 ---
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | cut -c2-3)" -lt 20 ]; then
  msg "Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
msg "  Node $(node -v)"

# --- 3. Descargar codigo del repo ---
TARBALL_URL="${REPO_URL}/archive/refs/heads/${REPO_BRANCH}.tar.gz"
msg "Descargando codigo desde $TARBALL_URL..."
mkdir -p "$INSTALL_DIR" /tmp/rmm-install
curl -fsSL "$TARBALL_URL" -o /tmp/rmm-install/repo.tar.gz || err "No se pudo descargar"
tar xzf /tmp/rmm-install/repo.tar.gz -C /tmp/rmm-install --no-same-owner 2>&1 | grep -v "Cannot change ownership" || true
EXTRACTED=$(find /tmp/rmm-install -maxdepth 1 -type d -name "dnns-rmm-server-*" | head -1)
[ -d "$EXTRACTED" ] || err "Estructura inesperada del repo"
cp "$EXTRACTED/server.js" "$INSTALL_DIR/"

# --- 4. SSHD dedicado en puerto alternativo ---
msg "Configurando sshd en puerto ${PUERTO_SSHD}..."
# Anadir Port secundario al sshd principal (mantiene 22 para admin)
if ! grep -qE "^Port ${PUERTO_SSHD}\$" /etc/ssh/sshd_config; then
  echo "" >> /etc/ssh/sshd_config
  echo "# DNNS RMM - aceptar tuneles inversos" >> /etc/ssh/sshd_config
  echo "Port 22" >> /etc/ssh/sshd_config 2>/dev/null || true
  echo "Port ${PUERTO_SSHD}" >> /etc/ssh/sshd_config
fi
# GatewayPorts necesario para que -R 0.0.0.0:PORT funcione (clientes pueden conectar)
if ! grep -q "^GatewayPorts" /etc/ssh/sshd_config; then
  echo "GatewayPorts clientspecified" >> /etc/ssh/sshd_config
fi
sshd -t || err "sshd_config invalido"
systemctl restart ssh

# --- 5. systemd unit para la API ---
msg "Creando servicio systemd dnns-rmm-server..."
cat > /etc/systemd/system/dnns-rmm-server.service <<UNIT
[Unit]
Description=DNNS RMM Server - API registro de agentes
After=network.target

[Service]
User=root
WorkingDirectory=${INSTALL_DIR}
Environment="PUERTO_API=${PUERTO_API}"
Environment="PUERTO_INICIAL_TUNEL=${RANGO_TUNNEL_MIN}"
Environment="PUERTO_FINAL_TUNEL=${RANGO_TUNNEL_MAX}"
Environment="RUTA_DATOS=${DATA_DIR}"
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
systemctl daemon-reload
systemctl enable --now dnns-rmm-server

# --- 6. Firewall ---
msg "Configurando firewall..."
ufw default deny incoming 2>/dev/null
ufw default allow outgoing 2>/dev/null
ufw allow 22/tcp comment 'SSH admin'
ufw allow ${PUERTO_SSHD}/tcp comment 'DNNS RMM tuneles'
# El rango de tunneles tambien debe ser accesible (al menos desde localhost para passkey/admin)
ufw allow ${RANGO_TUNNEL_MIN}:${RANGO_TUNNEL_MAX}/tcp comment 'DNNS RMM tunel range'
ufw --force enable 2>/dev/null

# --- 7. Verificacion ---
msg "Verificando..."
sleep 2
if curl -s http://127.0.0.1:${PUERTO_API}/api/salud | grep -q '"ok":true'; then
  msg "[OK] API funcionando"
else
  err "API no responde"
fi
if ss -tln | grep -q ":${PUERTO_SSHD} "; then
  msg "[OK] sshd escuchando en puerto ${PUERTO_SSHD}"
else
  err "sshd no escucha en ${PUERTO_SSHD}"
fi

# --- 8. Banner final ---
echo ""
echo "${G}========================================================="
echo " DNNS RMM SERVER instalado correctamente"
echo "=========================================================${N}"
echo ""
echo "  IP del server:    $(hostname -I | awk '{print $1}')"
echo "  Puerto sshd RMM:  ${PUERTO_SSHD}"
echo "  Puerto API:       127.0.0.1:${PUERTO_API} (solo localhost)"
echo "  Datos:            ${DATA_DIR}/agentes.json"
echo ""
echo "  Para que los agentes te encuentren:"
echo "    - Apunta tu DNS rmm.tudominio.com a esta IP"
echo "    - O usa la IP directamente como RMM_HOST en el agente"
echo ""
echo "  Ejemplo de instalacion de agente apuntando aqui:"
echo "    RMM_HOST=$(hostname -I | awk '{print $1}') \\"
echo "    PASSKEY_HOST=$(hostname -I | awk '{print $1}'):${PUERTO_API} \\"
echo "    bash <(curl -fsSL https://raw.githubusercontent.com/dnns-es/dnns-rmm-agent/main/install.sh)"
echo ""
echo "  Ver agentes registrados:"
echo "    curl http://127.0.0.1:${PUERTO_API}/api/agentes"
echo ""
