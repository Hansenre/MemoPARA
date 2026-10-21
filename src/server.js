import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createService } from './service.js';
import { PARA, resolveInside } from './vault.js';
import { createApostilaService } from './apostilas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VAULT_MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

function documentsDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
      if (m) return m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? '');
    } catch { /* usa o padrão abaixo */ }
  }
  return path.join(os.homedir(), 'Documents');
}

export function resolvePaths(env = process.env) {
  const dataDir = env.MEMOPARA_DATA || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'MemoPARA');
  let vaultDir = env.MEMOPARA_VAULT;
  const configFile = path.join(dataDir, 'config.json');
  if (!vaultDir && fs.existsSync(configFile)) {
    try { vaultDir = JSON.parse(fs.readFileSync(configFile, 'utf8')).vaultDir; } catch { /* ignora config corrompida */ }
  }
  if (!vaultDir) {
    vaultDir = path.join(documentsDir(), 'MemoPARA');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ vaultDir }, null, 2));
  }
  return { dataDir, vaultDir, dbPath: path.join(dataDir, 'memopara.db') };
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Requisição muito grande.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}

function openPath(target, select = false) {
  if (process.platform !== 'win32') return;
  execFile('explorer.exe', select ? [`/select,${target}`] : [target], { windowsHide: true }, () => {});
}

export function createApp({ service, apostilas = null, paths, onActivity = () => {} }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => ({ ok: true, app: 'MemoPARA' }));
  route('POST', '/api/heartbeat', () => ({ ok: true }));
  route('GET', '/api/meta', () => ({ para: PARA, paths, settings: service.getSettings() }));
  route('GET', '/api/dashboard', () => service.dashboard());
  route('GET', '/api/queue', ({ query }) => service.queue({ limit: query.get('limit'), noteId: query.get('note') }));
  route('GET', '/api/cards/:id', ({ params }) => service.cardForReview(params.id));
  route('POST', '/api/cards/:id/review', ({ params, body }) => service.reviewCard(params.id, body));
  route('POST', '/api/cards/:id/reset', ({ params }) => service.resetCard(params.id));
  route('POST', '/api/cards/:id/suspend', ({ params, body }) => service.setCardSuspended(params.id, body.suspended !== false));
  route('GET', '/api/tree', () => service.tree());
  route('POST', '/api/folders', ({ body }) => service.createFolder(body.para, body.folder));
  route('GET', '/api/notes', ({ query }) => service.listNotes({
    para: query.get('para') || undefined, folder: query.get('folder') ?? undefined, q: query.get('q'), limit: query.get('limit')
  }));
  route('POST', '/api/notes', ({ body }) => service.createNote(body));
  route('GET', '/api/notes/:id', ({ params }) => service.getNote(params.id));
  route('PUT', '/api/notes/:id', ({ params, body }) => service.updateNote(params.id, body));
  route('DELETE', '/api/notes/:id', ({ params }) => service.deleteNote(params.id));
  route('POST', '/api/notes/:id/reveal', ({ params }) => { openPath(service.notePathOf(params.id), true); return { ok: true }; });
  route('POST', '/api/vault/open', () => { openPath(paths.vaultDir); return { ok: true }; });
  route('POST', '/api/sync', () => service.syncVault());
  route('POST', '/api/alerts/:id/resolve', ({ params }) => service.resolveAlert(params.id));
  route('GET', '/api/settings', () => service.getSettings());
  route('PUT', '/api/settings', ({ body }) => service.updateSettings(body));
  route('GET', '/api/export', () => service.exportAll());
  route('POST', '/api/import', ({ body }) => service.importAll(body));

  if (apostilas) {
    route('GET', '/api/apostilas', () => apostilas.list());
    route('POST', '/api/apostilas', ({ body }) => apostilas.create(body));
    route('GET', '/api/apostilas/:id', ({ params }) => apostilas.get(params.id));
    route('PUT', '/api/apostilas/:id', ({ params, body }) => apostilas.update(params.id, body));
    route('DELETE', '/api/apostilas/:id', ({ params }) => apostilas.remove(params.id));
    route('POST', '/api/apostilas/:id/pages', ({ params, body }) => apostilas.addPage(params.id, body));
    route('PUT', '/api/apostilas/:id/order', ({ params, body }) => apostilas.reorder(params.id, body.pageIds));
    route('PUT', '/api/apostilas/:id/pages/:pageId', ({ params, body }) => apostilas.rotatePage(params.id, params.pageId, body));
    route('DELETE', '/api/apostilas/:id/pages/:pageId', ({ params }) => apostilas.deletePage(params.id, params.pageId));
    route('POST', '/api/apostilas/:id/pages/:pageId/ocr', ({ params }) => apostilas.ocrPage(params.id, params.pageId));
    route('POST', '/api/apostilas/:id/pdf', ({ params, body }) => apostilas.generate(params.id, body));
    route('POST', '/api/apostilas/:id/open-pdf', ({ params }) => { openPath(apostilas.pdfAbsPath(params.id)); return { ok: true }; });
    route('POST', '/api/apostilas/:id/reveal-pdf', ({ params }) => { openPath(apostilas.pdfAbsPath(params.id), true); return { ok: true }; });
  }

  return async (req, res) => {
    onActivity();
    // Só aceita acessos pelo próprio computador (bloqueia DNS rebinding).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      console.warn(`Acesso recusado (Host: ${req.headers.host})`);
      res.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname.startsWith('/vault/')) return serveVaultFile(res, url.pathname);
    return serveStatic(res, url.pathname);
  };

  // Arquivos do vault (PDFs e imagens) para links dentro das notas e miniaturas das apostilas.
  function serveVaultFile(res, pathname) {
    let file;
    try { file = resolveInside(paths.vaultDir, decodeURIComponent(pathname.slice('/vault/'.length))); } catch { res.writeHead(400).end(); return; }
    const type = VAULT_MIME[path.extname(file).toLowerCase()];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('Arquivo não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  async function handleApi(req, res, url) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const match = routes.map((r) => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find((x) => x.m);
      if (!match) return send(404, { error: 'Rota não encontrada.' });
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        // exigir JSON impede formulários de outros sites de acionarem a API (CSRF)
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'Use application/json.' });
        body = await readJson(req, url.pathname === '/api/import' ? 200 * 1024 * 1024 : 25 * 1024 * 1024);
      }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1])]));
      send(200, await match.r.handler({ params, query: url.searchParams, body }));
    } catch (err) {
      if (!err.status) console.error(err);
      send(err.status || 500, { error: err.status ? err.message : 'Erro interno.' });
    }
  }

  function serveStatic(res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }
}

function parseArgs(argv) {
  const args = { port: Number(process.env.MEMOPARA_PORT) || 5170, autoExit: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--auto-exit') args.autoExit = true;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths();
  const db = openDatabase(paths.dbPath);
  const service = createService({ db, vaultDir: paths.vaultDir });
  const apostilas = createApostilaService({ db, vaultDir: paths.vaultDir, notes: service });
  const sync = service.syncVault();
  let lastActivity = Date.now();
  const handler = createApp({ service, apostilas, paths, onActivity: () => { lastActivity = Date.now(); } });
  const server = http.createServer(handler);
  server.listen(args.port, '127.0.0.1', () => {
    console.log(`MemoPARA em http://127.0.0.1:${args.port}`);
    console.log(`Vault: ${paths.vaultDir}  |  Banco: ${paths.dbPath}  |  Sync: ${JSON.stringify(sync)}`);
  });
  // "localhost" pode resolver para IPv6; escuta também no loopback ::1 (nunca na rede)
  http.createServer(handler).on('error', () => {}).listen(args.port, '::1');
  if (args.autoExit) {
    // aberto pelo atalho: encerra sozinho alguns minutos depois que a janela fecha
    setInterval(() => {
      if (Date.now() - lastActivity > 4 * 60_000) { db.close(); process.exit(0); }
    }, 30_000).unref?.();
  }
}
