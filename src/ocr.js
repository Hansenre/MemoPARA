// OCR opcional: usa o Tesseract se ele estiver instalado (PATH ou pasta padrão no Windows).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (cmd, args, timeout = 120_000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject(err); else resolve(stdout);
  });
});

let cached = null;

export async function detectTesseract({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const candidates = ['tesseract'];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) candidates.push(path.join(base, 'Tesseract-OCR', 'tesseract.exe'));
    }
  }
  for (const cmd of candidates) {
    if (cmd !== 'tesseract' && !fs.existsSync(cmd)) continue;
    try {
      const version = (await run(cmd, ['--version'], 10_000)).split('\n')[0].trim();
      const langs = (await run(cmd, ['--list-langs'], 10_000)).split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
      const wanted = ['por', 'eng'].filter((l) => langs.includes(l));
      cached = { available: true, cmd, version, langs: wanted.length ? wanted : langs.slice(0, 1) };
      return cached;
    } catch { /* tenta o próximo */ }
  }
  cached = { available: false };
  return cached;
}

export async function ocrImage(imagePath) {
  const t = await detectTesseract();
  if (!t.available) throw Object.assign(new Error('Tesseract não está instalado.'), { status: 400 });
  const args = [imagePath, 'stdout', '--psm', '3'];
  if (t.langs.length) args.push('-l', t.langs.join('+'));
  const text = await run(t.cmd, args);
  return text.replace(/\f/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
