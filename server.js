/* Fecha: 2026-04-20
   Ruta: /opt/dnns-rmm-server/server.js
   Contenido: API minima del servidor RMM. Acepta registros de agentes,
              crea usuarios tunnel-N en el sistema, asigna puerto unico
              y devuelve {user, port} al agente. Software gratuito sin
              animo de lucro. */

const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PUERTO_API = parseInt(process.env.PUERTO_API || '3001', 10);
const PUERTO_INICIAL_TUNEL = parseInt(process.env.PUERTO_INICIAL_TUNEL || '40000', 10);
const PUERTO_FINAL_TUNEL = parseInt(process.env.PUERTO_FINAL_TUNEL || '40999', 10);
const RUTA_DATOS = process.env.RUTA_DATOS || '/var/lib/dnns-rmm-server';
const RUTA_AGENTES = path.join(RUTA_DATOS, 'agentes.json');
// Token opcional. Si esta definido, el endpoint /api/agentes/registrar
// requiere header X-Registration-Token: <valor>. Si no, abierto (modo dev).
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN || '';

// ------ VALIDADORES ------
const RE_HOSTNAME = /^[a-zA-Z0-9._-]{1,253}$/;
const RE_HW_ID    = /^[a-f0-9]{32,128}$/i;
const RE_EMAIL    = /^[^\s<>"'@]+@[^\s<>"'@]+\.[^\s<>"'@]+$/;
const RE_DOMINIO  = /^[a-zA-Z0-9._-]{1,253}(:\d{1,5})?$/;
const RE_PUBKEY   = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|ssh-dss)\s+[A-Za-z0-9+/=]{40,}(\s+[\x21-\x7e]+)?$/;
const RE_USER_NAME= /^[a-zA-Z0-9._-]{1,100}$/;

function validar(datos) {
  const e = [];
  if (!RE_HOSTNAME.test(datos.hostname || '')) e.push('hostname invalido');
  if (!RE_HW_ID.test(datos.hw_id || '')) e.push('hw_id invalido');
  // pubkey debe ser UNA sola linea (sin saltos), formato ssh-keygen estandar
  const pubkey = (datos.agent_pubkey || '').trim();
  if (pubkey.includes('\n') || pubkey.includes('\r')) e.push('agent_pubkey con saltos de linea');
  if (!RE_PUBKEY.test(pubkey)) e.push('agent_pubkey formato invalido');
  if (datos.ct_ip && !/^[0-9a-fA-F:.]{1,45}$/.test(datos.ct_ip)) e.push('ct_ip invalido');
  if (datos.dominio && !RE_DOMINIO.test(datos.dominio)) e.push('dominio invalido');
  if (datos.admin_email && !RE_EMAIL.test(datos.admin_email)) e.push('admin_email invalido');
  if (datos.admin_name && !RE_USER_NAME.test(datos.admin_name)) e.push('admin_name invalido');
  if (datos.producto && !RE_USER_NAME.test(datos.producto)) e.push('producto invalido');
  return e;
}

if (!fs.existsSync(RUTA_DATOS)) fs.mkdirSync(RUTA_DATOS, { recursive: true });
if (!fs.existsSync(RUTA_AGENTES)) fs.writeFileSync(RUTA_AGENTES, '[]');

function cargarAgentes() {
  try { return JSON.parse(fs.readFileSync(RUTA_AGENTES, 'utf8')); }
  catch (e) { return []; }
}

function guardarAgentes(lista) {
  fs.writeFileSync(RUTA_AGENTES, JSON.stringify(lista, null, 2));
}

function siguientePuerto(agentes) {
  const usados = new Set(agentes.map(a => a.port));
  for (let p = PUERTO_INICIAL_TUNEL; p <= PUERTO_FINAL_TUNEL; p++) {
    if (!usados.has(p)) return p;
  }
  return null;
}

function siguienteIndice(agentes) {
  const ids = agentes.map(a => parseInt((a.user || '').replace('tunnel-', ''), 10)).filter(n => !isNaN(n));
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function existeUsuario(user) {
  try { execSync(`id ${user}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function crearUsuarioTunel(user, agentPubkey) {
  if (!existeUsuario(user)) {
    execSync(`useradd -r -m -s /usr/sbin/nologin ${user}`);
  }
  const sshDir = `/home/${user}/.ssh`;
  const authKeys = `${sshDir}/authorized_keys`;
  execSync(`mkdir -p ${sshDir} && chmod 700 ${sshDir}`);
  execSync(`chown ${user}:${user} ${sshDir}`);
  // Restringir a solo port forwarding (sin shell)
  const restriccion = 'no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,command="echo Solo tunel"';
  const linea = `${restriccion} ${agentPubkey}`;
  fs.writeFileSync(authKeys, linea + '\n');
  execSync(`chmod 600 ${authKeys}`);
  execSync(`chown ${user}:${user} ${authKeys}`);
}

function leerJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function enviarJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return enviarJson(res, 200, { ok: true });

  const url = req.url.split('?')[0];

  // Healthcheck
  if (req.method === 'GET' && url === '/api/salud') {
    return enviarJson(res, 200, { ok: true, servicio: 'dnns-rmm-server', agentes: cargarAgentes().length });
  }

  // Listado (debug, sin auth - en produccion proteger)
  if (req.method === 'GET' && url === '/api/agentes') {
    const lista = cargarAgentes().map(a => ({
      hostname: a.hostname,
      ct_ip: a.ct_ip,
      user: a.user,
      port: a.port,
      dominio: a.dominio,
      admin_email: a.admin_email,
      producto: a.producto,
      registrado: a.registrado
    }));
    return enviarJson(res, 200, { agentes: lista });
  }

  // Registro de agente
  if (req.method === 'POST' && url === '/api/agentes/registrar') {
    try {
      // Auth opcional via token
      if (REGISTRATION_TOKEN) {
        const t = req.headers['x-registration-token'];
        if (t !== REGISTRATION_TOKEN) {
          return enviarJson(res, 401, { ok: false, error: 'Token invalido o ausente' });
        }
      }

      const datos = await leerJsonBody(req);
      const obligatorios = ['hostname', 'hw_id', 'agent_pubkey'];
      const faltan = obligatorios.filter(k => !datos[k]);
      if (faltan.length) return enviarJson(res, 400, { ok: false, error: 'Faltan campos: ' + faltan.join(', ') });

      // Validacion estricta de formato
      const errores = validar(datos);
      if (errores.length) return enviarJson(res, 400, { ok: false, error: errores.join('; ') });

      const agentes = cargarAgentes();
      // Si ya existe por hw_id, devolver el mismo (re-registro)
      let existente = agentes.find(a => a.hw_id === datos.hw_id);
      if (existente) {
        // Actualizar metadata refrescable
        existente.hostname = datos.hostname;
        existente.ct_ip = datos.ct_ip;
        existente.dominio = datos.dominio || existente.dominio;
        existente.admin_email = datos.admin_email || existente.admin_email;
        existente.admin_name = datos.admin_name || existente.admin_name;
        existente.producto = datos.producto || existente.producto;
        existente.version = datos.version || existente.version;
        existente.ultima_actualizacion = new Date().toISOString();
        // Re-asegurar pubkey
        try { crearUsuarioTunel(existente.user, datos.agent_pubkey); } catch (e) {}
        guardarAgentes(agentes);
        return enviarJson(res, 200, { ok: true, user: existente.user, port: existente.port, reuso: true });
      }

      const port = siguientePuerto(agentes);
      if (!port) return enviarJson(res, 503, { ok: false, error: 'Sin puertos libres' });

      const idx = siguienteIndice(agentes);
      const user = `tunnel-${idx}`;

      crearUsuarioTunel(user, datos.agent_pubkey);

      const nuevo = {
        hostname: datos.hostname,
        ct_ip: datos.ct_ip || null,
        hw_id: datos.hw_id,
        agent_pubkey: datos.agent_pubkey,
        producto: datos.producto || 'generic',
        version: datos.version || null,
        admin_email: datos.admin_email || null,
        admin_name: datos.admin_name || null,
        dominio: datos.dominio || null,
        user,
        port,
        registrado: new Date().toISOString(),
        ultima_actualizacion: new Date().toISOString()
      };
      agentes.push(nuevo);
      guardarAgentes(agentes);
      return enviarJson(res, 200, { ok: true, user, port, reuso: false });
    } catch (e) {
      console.error('[ERROR]', e);
      return enviarJson(res, 500, { ok: false, error: e.message });
    }
  }

  // Heartbeat (opcional, mantener "online")
  if (req.method === 'POST' && url === '/api/agentes/heartbeat') {
    try {
      const datos = await leerJsonBody(req);
      const agentes = cargarAgentes();
      const idx = agentes.findIndex(a => a.hostname === datos.hostname);
      if (idx >= 0) {
        agentes[idx].ultimo_heartbeat = new Date().toISOString();
        guardarAgentes(agentes);
      }
      return enviarJson(res, 200, { ok: true });
    } catch (e) {
      return enviarJson(res, 500, { ok: false });
    }
  }

  enviarJson(res, 404, { error: 'Ruta no encontrada' });
});

server.listen(PUERTO_API, '127.0.0.1', () => {
  console.log(`[DNNS-RMM-SERVER] API escuchando en 127.0.0.1:${PUERTO_API}`);
  console.log(`[DNNS-RMM-SERVER] Datos en ${RUTA_DATOS}`);
  console.log(`[DNNS-RMM-SERVER] Rango puertos tunel: ${PUERTO_INICIAL_TUNEL}-${PUERTO_FINAL_TUNEL}`);
});
