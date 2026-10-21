import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PARA = {
  inbox: { dir: 'Inbox', label: 'Entrada' },
  projects: { dir: 'Projects', label: 'Projetos' },
  areas: { dir: 'Areas', label: 'Áreas' },
  resources: { dir: 'Resources', label: 'Recursos' },
  archives: { dir: 'Archives', label: 'Arquivo' }
};
const DIR_TO_PARA = Object.fromEntries(Object.entries(PARA).map(([k, v]) => [v.dir.toLowerCase(), k]));
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const NOTE_EXT = new Set(['.md', '.markdown', '.txt']);

export function assertPara(para) {
  if (!PARA[para]) throw httpError(400, 'Categoria PARA inválida.');
  return para;
}

export function sanitizeSegment(value, max = 80) {
  let s = String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '').slice(0, max).trim();
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

export function sanitizeFolder(value) {
  return String(value ?? '')
    .split(/[\\/]+/)
    .map((seg) => sanitizeSegment(seg, 60))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

export function resolveInside(base, relative) {
  const target = path.resolve(base, String(relative ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw httpError(400, 'Caminho inválido.');
  return target;
}

export const toUnix = (p) => p.split(path.sep).join('/');

export function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// ---------- front matter ----------
// Gravamos o id da nota no front matter (compatível com Obsidian) para que
// renomear/mover o arquivo fora do app não perca o histórico de revisões.
export function splitFrontMatter(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: [], body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: [], body: text };
  const meta = text.slice(4, end).split('\n');
  const body = text.slice(end + 4).replace(/^[^\n]*\n/, '').replace(/^\n/, '');
  return { meta, body };
}

export function readNoteFile(absPath) {
  const { meta, body } = splitFrontMatter(fs.readFileSync(absPath, 'utf8'));
  const idLine = meta.find((l) => /^memopara:\s*/.test(l));
  return { id: idLine ? idLine.replace(/^memopara:\s*/, '').trim() : null, meta, body };
}

export function writeNoteFile(absPath, id, body, existingMeta = null) {
  let meta = existingMeta;
  if (!meta && fs.existsSync(absPath)) meta = readNoteFile(absPath).meta;
  meta = (meta || []).filter((l) => !/^memopara:\s*/.test(l));
  const content = ['---', `memopara: ${id}`, ...meta, '---', '', String(body ?? '').replace(/\r\n/g, '\n')].join('\n');
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

// ---------- flashcards ----------
// Linhas "pergunta :: resposta" viram cartões. Blocos de código são ignorados.
export function parseFlashcards(body) {
  const cards = [];
  let inCode = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.+?)\s+::\s+(.+?)\s*$/);
    if (!m) continue;
    const prompt = m[1].trim();
    const answer = m[2].trim();
    if (!prompt || !answer) continue;
    cards.push({ key: 'qa:' + hash(prompt.toLowerCase()).slice(0, 16), prompt, answer });
  }
  const seen = new Set();
  return cards.filter((c) => !seen.has(c.key) && seen.add(c.key));
}

export function titleFromBody(body, fallback) {
  const m = String(body ?? '').match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).trim().slice(0, 200) || 'Sem título';
}

// ---------- caminhos ----------
export function notePath(para, folder, title) {
  const parts = [PARA[para].dir];
  if (folder) parts.push(folder);
  parts.push(`${sanitizeSegment(title) || 'Nota'}.md`);
  return parts.join('/');
}

export function uniquePath(vaultDir, relPath, ignoreRel = null) {
  const ext = path.posix.extname(relPath);
  const stem = relPath.slice(0, -ext.length);
  let candidate = relPath;
  for (let i = 2; ; i++) {
    if (candidate === ignoreRel) return candidate;
    if (!fs.existsSync(resolveInside(vaultDir, candidate))) return candidate;
    candidate = `${stem} (${i})${ext}`;
  }
}

export function locate(relPath) {
  const parts = relPath.split('/');
  const para = DIR_TO_PARA[(parts[0] || '').toLowerCase()] || null;
  return { para, folder: parts.slice(1, -1).join('/') };
}

export function ensureVault(vaultDir) {
  for (const { dir } of Object.values(PARA)) fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
}

// Lista todos os arquivos de nota do vault (ignora pastas ocultas como .trash/.obsidian).
export function walkNotes(vaultDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (NOTE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(toUnix(path.relative(vaultDir, abs)));
    }
  };
  for (const { dir } of Object.values(PARA)) {
    const abs = path.join(vaultDir, dir);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

export function listFolders(vaultDir) {
  const out = {};
  for (const [key, { dir }] of Object.entries(PARA)) {
    out[key] = [];
    const base = path.join(vaultDir, dir);
    const walk = (abs) => {
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const child = path.join(abs, e.name);
        out[key].push(toUnix(path.relative(base, child)));
        walk(child);
      }
    };
    walk(base);
    out[key].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }
  return out;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
