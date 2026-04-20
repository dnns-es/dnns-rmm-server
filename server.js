/* Fecha: 2026-04-20
   Ruta: /opt/dnns-rmm-server/server.js
   Contenido: API + UI web del servidor RMM. Acepta registros de agentes,
              crea usuarios tunnel-N, gestiona via panel web con auth JWT.
              Software gratuito sin animo de lucro. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { Client: SSHClient } = require('ssh2');

const PUERTO_API = parseInt(process.env.PUERTO_API || '3001', 10);
const PUERTO_INICIAL_TUNEL = parseInt(process.env.PUERTO_INICIAL_TUNEL || '40000', 10);
const PUERTO_FINAL_TUNEL = parseInt(process.env.PUERTO_FINAL_TUNEL || '40999', 10);
const RUTA_DATOS = process.env.RUTA_DATOS || '/var/lib/dnns-rmm-server';
const RUTA_AGENTES = path.join(RUTA_DATOS, 'agentes.json');
const PUBLICO = path.join(__dirname, 'publico');
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Si vacio, se genera al arranque y se loguea (usar variable env en produccion)
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRA_MS = 8 * 60 * 60 * 1000; // 8 horas

if (!fs.existsSync(RUTA_DATOS)) fs.mkdirSync(RUTA_DATOS, { recursive: true });
if (!fs.existsSync(RUTA_AGENTES)) fs.writeFileSync(RUTA_AGENTES, '[]');

// ============================================================
// Keypair del SERVER (para conectar por SSH al tunel de cada agente)
// Generada al arranque si no existe. La pubkey se envia al agente
// al registrarse, y el agente la inyecta en root's authorized_keys.
// ============================================================
const SSH_DIR = path.join(RUTA_DATOS, 'ssh');
if (!fs.existsSync(SSH_DIR)) fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
const SSH_KEY_PRIV = path.join(SSH_DIR, 'id_ed25519');
const SSH_KEY_PUB = path.join(SSH_DIR, 'id_ed25519.pub');
if (!fs.existsSync(SSH_KEY_PRIV)) {
  try {
    execSync(`ssh-keygen -t ed25519 -C "dnns-rmm-server@$(hostname)" -f ${SSH_KEY_PRIV} -N "" -q`);
    fs.chmodSync(SSH_KEY_PRIV, 0o600);
    console.log('[SSH] Keypair generada en ' + SSH_KEY_PRIV);
  } catch (e) {
    console.error('[SSH] No se pudo generar keypair:', e.message);
  }
}
const SERVER_PUBKEY = fs.existsSync(SSH_KEY_PUB) ? fs.readFileSync(SSH_KEY_PUB, 'utf8').trim() : '';

// Persistencia de password: si no hay env, intenta leer del archivo, si no genera
const PATH_PW = path.join(RUTA_DATOS, 'admin-password.txt');
function leerPasswordPersistida() {
  try {
    const c = fs.readFileSync(PATH_PW, 'utf8');
    const m = c.match(/^Password:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function guardarPasswordPersistida(pw) {
  fs.writeFileSync(PATH_PW, `Usuario: ${ADMIN_USER}\nPassword: ${pw}\nActualizada: ${new Date().toISOString()}\n`);
  fs.chmodSync(PATH_PW, 0o600);
}
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = leerPasswordPersistida();
  if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').substring(0, 16);
    guardarPasswordPersistida(ADMIN_PASSWORD);
    console.log('[ADMIN] Password generada en ' + PATH_PW);
  } else {
    console.log('[ADMIN] Password leida de ' + PATH_PW);
  }
}

// ============================================================
// VALIDADORES
// ============================================================
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

// ============================================================
// PERSISTENCIA
// ============================================================
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

// ============================================================
// SISTEMA - usuarios tunnel
// ============================================================
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
  const restriccion = 'no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,command="echo Solo tunel"';
  fs.writeFileSync(authKeys, restriccion + ' ' + agentPubkey + '\n');
  execSync(`chmod 600 ${authKeys}`);
  execSync(`chown ${user}:${user} ${authKeys}`);
}
function eliminarUsuarioTunel(user) {
  if (!existeUsuario(user)) return;
  try { execSync(`pkill -u ${user}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`userdel -r ${user}`, { stdio: 'ignore' }); } catch {}
}

// ============================================================
// JWT minimo (HS256)
// ============================================================
function firmar(payload, expiraMs = JWT_EXPIRA_MS) {
  const cabecera = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const cuerpo = b64url(JSON.stringify({ ...payload, exp: Date.now() + expiraMs }));
  const firma = b64url(crypto.createHmac('sha256', JWT_SECRET).update(cabecera + '.' + cuerpo).digest());
  return cabecera + '.' + cuerpo + '.' + firma;
}
function verificar(token) {
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [h, c, f] = partes;
  const calc = b64url(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + c).digest());
  if (calc !== f) return null;
  try {
    const payload = JSON.parse(Buffer.from(c, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function leerCookie(req, nombre) {
  const cookieHeader = req.headers.cookie || '';
  const m = cookieHeader.match(new RegExp('(?:^|; )' + nombre + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function autenticado(req) {
  const token = leerCookie(req, 'rmm_session');
  return verificar(token);
}

// ============================================================
// HELPERS HTTP
// ============================================================
function leerJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; let bytes = 0;
    req.on('data', c => { body += c; bytes += c.length; if (bytes > 1024 * 100) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function enviarJson(res, status, obj, cabecerasExtra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...cabecerasExtra
  });
  res.end(JSON.stringify(obj));
}
function enviarArchivo(res, rutaRel, contentType) {
  const archivo = path.join(PUBLICO, rutaRel);
  if (!archivo.startsWith(PUBLICO)) return enviarJson(res, 403, { error: 'forbidden' });
  fs.readFile(archivo, (err, data) => {
    if (err) return enviarJson(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ============================================================
// SERVIDOR
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return enviarJson(res, 200, { ok: true });

  const url = req.url.split('?')[0];

  // ----- API publica -----
  if (req.method === 'GET' && url === '/api/salud') {
    return enviarJson(res, 200, { ok: true, servicio: 'dnns-rmm-server', agentes: cargarAgentes().length });
  }

  // Pubkey del server (para que agentes la anadan a root's authorized_keys)
  if (req.method === 'GET' && url === '/api/pubkey') {
    return enviarJson(res, 200, { pubkey: SERVER_PUBKEY });
  }

  // ----- AUTH -----
  if (req.method === 'POST' && url === '/api/auth/login') {
    try {
      const { user, password } = await leerJsonBody(req);
      if (user !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        return enviarJson(res, 401, { ok: false, error: 'Credenciales invalidas' });
      }
      const token = firmar({ user });
      const cookie = `rmm_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${JWT_EXPIRA_MS/1000}; SameSite=Strict`;
      return enviarJson(res, 200, { ok: true, user }, { 'Set-Cookie': cookie });
    } catch (e) {
      return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }
  }

  if (req.method === 'POST' && url === '/api/auth/logout') {
    return enviarJson(res, 200, { ok: true }, { 'Set-Cookie': 'rmm_session=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (req.method === 'GET' && url === '/api/auth/yo') {
    const sess = autenticado(req);
    if (!sess) return enviarJson(res, 401, { error: 'No autenticado' });
    return enviarJson(res, 200, { user: sess.user });
  }

  // Cambiar password (autenticado)
  if (req.method === 'POST' && url === '/api/auth/cambiar-password') {
    const sess = autenticado(req);
    if (!sess) return enviarJson(res, 401, { error: 'No autenticado' });
    try {
      const { actual, nueva } = await leerJsonBody(req);
      if (!actual || actual !== ADMIN_PASSWORD) {
        return enviarJson(res, 401, { ok: false, error: 'Password actual incorrecta' });
      }
      if (!nueva || nueva.length < 8) {
        return enviarJson(res, 400, { ok: false, error: 'La nueva password debe tener mínimo 8 caracteres' });
      }
      ADMIN_PASSWORD = nueva;
      guardarPasswordPersistida(nueva);
      return enviarJson(res, 200, { ok: true });
    } catch (e) {
      return enviarJson(res, 400, { ok: false, error: 'JSON inválido' });
    }
  }

  // ----- REGISTRO de agentes (publico, con token opcional) -----
  if (req.method === 'POST' && url === '/api/agentes/registrar') {
    try {
      if (REGISTRATION_TOKEN) {
        const t = req.headers['x-registration-token'];
        if (t !== REGISTRATION_TOKEN) return enviarJson(res, 401, { ok: false, error: 'Token invalido' });
      }
      const datos = await leerJsonBody(req);
      const obligatorios = ['hostname', 'hw_id', 'agent_pubkey'];
      const faltan = obligatorios.filter(k => !datos[k]);
      if (faltan.length) return enviarJson(res, 400, { ok: false, error: 'Faltan campos: ' + faltan.join(', ') });
      const errores = validar(datos);
      if (errores.length) return enviarJson(res, 400, { ok: false, error: errores.join('; ') });

      const agentes = cargarAgentes();
      let existente = agentes.find(a => a.hw_id === datos.hw_id);
      if (existente) {
        existente.hostname = datos.hostname;
        existente.ct_ip = datos.ct_ip || existente.ct_ip;
        existente.dominio = datos.dominio || existente.dominio;
        existente.admin_email = datos.admin_email || existente.admin_email;
        existente.admin_name = datos.admin_name || existente.admin_name;
        existente.producto = datos.producto || existente.producto;
        existente.version = datos.version || existente.version;
        existente.ultima_actualizacion = new Date().toISOString();
        try { crearUsuarioTunel(existente.user, datos.agent_pubkey); } catch (e) {}
        guardarAgentes(agentes);
        return enviarJson(res, 200, { ok: true, user: existente.user, port: existente.port, reuso: true, server_pubkey: SERVER_PUBKEY });
      }

      const port = siguientePuerto(agentes);
      if (!port) return enviarJson(res, 503, { ok: false, error: 'Sin puertos libres' });
      const idx = siguienteIndice(agentes);
      const user = `tunnel-${idx}`;
      crearUsuarioTunel(user, datos.agent_pubkey);

      const nuevo = {
        hostname: datos.hostname, ct_ip: datos.ct_ip || null, hw_id: datos.hw_id,
        agent_pubkey: datos.agent_pubkey,
        producto: datos.producto || 'generic', version: datos.version || null,
        admin_email: datos.admin_email || null, admin_name: datos.admin_name || null,
        dominio: datos.dominio || null,
        user, port,
        registrado: new Date().toISOString(), ultima_actualizacion: new Date().toISOString()
      };
      agentes.push(nuevo);
      guardarAgentes(agentes);
      return enviarJson(res, 200, { ok: true, user, port, reuso: false, server_pubkey: SERVER_PUBKEY });
    } catch (e) {
      console.error('[ERROR registrar]', e);
      return enviarJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url === '/api/agentes/heartbeat') {
    try {
      const datos = await leerJsonBody(req);
      const agentes = cargarAgentes();
      const idx = agentes.findIndex(a => a.hostname === datos.hostname);
      if (idx >= 0) { agentes[idx].ultimo_heartbeat = new Date().toISOString(); guardarAgentes(agentes); }
      return enviarJson(res, 200, { ok: true });
    } catch { return enviarJson(res, 500, { ok: false }); }
  }

  // ----- ENDPOINTS PROTEGIDOS (admin) -----
  if (url.startsWith('/api/admin/') || (req.method === 'GET' && url === '/api/agentes') ||
      (req.method === 'DELETE' && url.startsWith('/api/agentes/'))) {
    if (!autenticado(req)) return enviarJson(res, 401, { error: 'No autenticado' });
  }

  if (req.method === 'GET' && url === '/api/agentes') {
    // Endpoint admin: incluye hw_id (necesario para borrado).
    // No incluye agent_pubkey por brevedad.
    const lista = cargarAgentes().map(a => ({
      _hw_id: a.hw_id,
      hostname: a.hostname, ct_ip: a.ct_ip, user: a.user, port: a.port,
      dominio: a.dominio, admin_email: a.admin_email, admin_name: a.admin_name,
      producto: a.producto, version: a.version,
      registrado: a.registrado, ultima_actualizacion: a.ultima_actualizacion,
      ultimo_heartbeat: a.ultimo_heartbeat || null
    }));
    return enviarJson(res, 200, { agentes: lista });
  }

  if (req.method === 'DELETE' && url.startsWith('/api/agentes/')) {
    const hwid = url.replace('/api/agentes/', '');
    const agentes = cargarAgentes();
    const idx = agentes.findIndex(a => a.hw_id === hwid);
    if (idx < 0) return enviarJson(res, 404, { ok: false, error: 'No existe' });
    const user = agentes[idx].user;
    eliminarUsuarioTunel(user);
    agentes.splice(idx, 1);
    guardarAgentes(agentes);
    return enviarJson(res, 200, { ok: true });
  }

  // Cambiar puerto del túnel de un agente
  if (req.method === 'POST' && url.match(/^\/api\/agentes\/[^/]+\/puerto$/)) {
    try {
      const hwid = url.split('/')[3];
      const { port } = await leerJsonBody(req);
      const nuevoPort = parseInt(port, 10);
      if (isNaN(nuevoPort) || nuevoPort < PUERTO_INICIAL_TUNEL || nuevoPort > PUERTO_FINAL_TUNEL) {
        return enviarJson(res, 400, { ok: false, error: `Puerto debe estar entre ${PUERTO_INICIAL_TUNEL} y ${PUERTO_FINAL_TUNEL}` });
      }
      const agentes = cargarAgentes();
      const idx = agentes.findIndex(a => a.hw_id === hwid);
      if (idx < 0) return enviarJson(res, 404, { ok: false, error: 'Agente no existe' });
      if (agentes.some((a, i) => i !== idx && a.port === nuevoPort)) {
        return enviarJson(res, 409, { ok: false, error: 'Puerto ya en uso por otro agente' });
      }
      agentes[idx].port = nuevoPort;
      agentes[idx].ultima_actualizacion = new Date().toISOString();
      guardarAgentes(agentes);
      return enviarJson(res, 200, { ok: true, port: nuevoPort, aviso: 'El agente debe reconectarse para usar el nuevo puerto' });
    } catch (e) {
      return enviarJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ----- HTML / Estaticos -----
  if (req.method === 'GET') {
    if (url === '/' || url === '/login') return enviarArchivo(res, 'login.html', TIPOS['.html']);
    if (url === '/admin' || url === '/agentes') return enviarArchivo(res, 'admin.html', TIPOS['.html']);
    if (url === '/consola') {
      if (!autenticado(req)) {
        res.writeHead(302, { 'Location': '/login' });
        return res.end();
      }
      return enviarArchivo(res, 'consola.html', TIPOS['.html']);
    }
    const ext = path.extname(url).toLowerCase();
    if (TIPOS[ext]) return enviarArchivo(res, url.replace(/^\//, ''), TIPOS[ext]);
  }

  enviarJson(res, 404, { error: 'Ruta no encontrada' });
});

// ============================================================
// WEBSOCKET - Consola web via SSH
// URL: wss://rmm.dnns.es/ws/consola?port=40000
// Autenticado con la cookie rmm_session (JWT).
// ============================================================
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/consola')) {
    socket.destroy();
    return;
  }
  // Auth via cookie
  const sess = autenticado(req);
  if (!sess) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const port = parseInt(urlObj.searchParams.get('port') || '0', 10);
  if (!port || port < PUERTO_INICIAL_TUNEL || port > PUERTO_FINAL_TUNEL) {
    ws.send('\x1b[31mPuerto invalido\x1b[0m\r\n');
    ws.close();
    return;
  }

  // Verificar que hay un agente registrado en ese puerto
  const agente = cargarAgentes().find(a => a.port === port);
  if (!agente) {
    ws.send('\x1b[31mNo hay agente en ese puerto\x1b[0m\r\n');
    ws.close();
    return;
  }

  ws.send(`\x1b[32m[*] Conectando a ${agente.hostname} (${agente.user}:${port})...\x1b[0m\r\n`);

  let ssh;
  try {
    ssh = new SSHClient();
  } catch (e) {
    ws.send('\x1b[31mSSH client no disponible: ' + e.message + '\x1b[0m\r\n');
    ws.close();
    return;
  }

  ssh.on('ready', () => {
    ws.send('\x1b[32m[+] Conectado\x1b[0m\r\n');
    ssh.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) { ws.send('\x1b[31mShell error: ' + err.message + '\x1b[0m'); ws.close(); return; }
      stream.on('data', (d) => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
      stream.on('close', () => ws.close());
      stream.stderr.on('data', (d) => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
      ws.on('message', (msg) => {
        try {
          const s = msg.toString('utf8');
          if (s.startsWith('{"tipo":"resize"')) {
            const j = JSON.parse(s);
            stream.setWindow(j.rows || 24, j.cols || 80);
            return;
          }
          stream.write(s);
        } catch { stream.write(msg); }
      });
      ws.on('close', () => { try { stream.end(); } catch {} try { ssh.end(); } catch {} });
    });
  });

  ssh.on('error', (err) => {
    ws.send('\x1b[31m[!] Error SSH: ' + err.message + '\x1b[0m\r\n');
    try { ws.close(); } catch {}
  });

  ssh.on('close', () => { try { ws.close(); } catch {} });

  try {
    ssh.connect({
      host: '127.0.0.1',
      port: port,
      username: 'root',
      privateKey: fs.readFileSync(SSH_KEY_PRIV),
      readyTimeout: 15000
    });
  } catch (e) {
    ws.send('\x1b[31m[!] No se pudo iniciar SSH: ' + e.message + '\x1b[0m\r\n');
    ws.close();
  }
});

server.listen(PUERTO_API, BIND_HOST, () => {
  console.log(`[DNNS-RMM-SERVER] API escuchando en ${BIND_HOST}:${PUERTO_API}`);
  console.log(`[DNNS-RMM-SERVER] Datos en ${RUTA_DATOS}`);
  console.log(`[DNNS-RMM-SERVER] Rango puertos tunel: ${PUERTO_INICIAL_TUNEL}-${PUERTO_FINAL_TUNEL}`);
  console.log(`[DNNS-RMM-SERVER] Admin user: ${ADMIN_USER}`);
  if (BIND_HOST !== '127.0.0.1' && !REGISTRATION_TOKEN) {
    console.warn('[WARN] API expuesta SIN REGISTRATION_TOKEN. Protege con firewall+NPM auth.');
  }
});
