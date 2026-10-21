// Apostilas: fotos de páginas -> PDF no vault PARA + nota de estudo vinculada.
// As fotos ficam em <vault>/.memopara/apostilas/<id>/ (pasta oculta: o vault não as trata como notas).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPdf, jpegInfo } from './pdf.js';
import { detectTesseract, ocrImage } from './ocr.js';
import { PARA, assertPara, sanitizeFolder, sanitizeSegment, resolveInside, uniquePath, httpError } from './vault.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const OCR_HEADING = '## Texto extraído (OCR)';

export function createApostilaService({ db, vaultDir, notes, clock = () => new Date(), ocr = { detectTesseract, ocrImage } }) {
  const dirRel = (id) => `.memopara/apostilas/${id}`;
  const abs = (rel) => resolveInside(vaultDir, rel);
  const fileUrl = (rel) => `/vault/${rel.split('/').map(encodeURIComponent).join('/')}`;

  function row(id) {
    const r = db.prepare('SELECT * FROM apostilas WHERE id = ?').get(String(id));
    if (!r) throw httpError(404, 'Apostila não encontrada.');
    return r;
  }
  const pagesOf = (id) => db.prepare('SELECT * FROM apostila_pages WHERE apostila_id = ? ORDER BY ord, id').all(id);
  const touch = (id) => db.prepare('UPDATE apostilas SET updated_at = ? WHERE id = ?').run(clock().toISOString(), id);

  function cleanTitle(title) {
    const t = String(title ?? '').trim().slice(0, 150);
    if (!t) throw httpError(400, 'Informe o nome da apostila.');
    return t;
  }

  function noteExists(noteId) {
    return noteId && db.prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId);
  }

  function list() {
    return db.prepare(`SELECT a.*, n.title AS note_title,
        (SELECT COUNT(*) FROM apostila_pages p WHERE p.apostila_id = a.id) AS pages,
        (SELECT file FROM apostila_pages p WHERE p.apostila_id = a.id ORDER BY ord, id LIMIT 1) AS cover
      FROM apostilas a LEFT JOIN notes n ON n.id = a.note_id ORDER BY a.updated_at DESC`).all()
      .map((a) => ({ ...a, cover: a.cover ? fileUrl(a.cover) : null, pdf_url: a.pdf_path ? fileUrl(a.pdf_path) : null }));
  }

  async function get(id) {
    const a = row(id);
    return {
      ...a,
      pdf_url: a.pdf_path && fs.existsSync(abs(a.pdf_path)) ? fileUrl(a.pdf_path) : null,
      note: noteExists(a.note_id) ? { id: a.note_id, title: db.prepare('SELECT title FROM notes WHERE id = ?').get(a.note_id).title } : null,
      pages: pagesOf(a.id).map((p) => ({ ...p, url: fileUrl(p.file), original_url: fileUrl(p.original) })),
      ocr: await ocr.detectTesseract()
    };
  }

  function create({ title, para = 'resources', folder = '' }) {
    const id = crypto.randomUUID();
    const now = clock().toISOString();
    db.prepare('INSERT INTO apostilas (id, title, para, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, cleanTitle(title), assertPara(para), sanitizeFolder(folder), now, now);
    fs.mkdirSync(abs(dirRel(id)), { recursive: true });
    return get(id);
  }

  function update(id, patch) {
    const a = row(id);
    db.prepare('UPDATE apostilas SET title = ?, para = ?, folder = ?, updated_at = ? WHERE id = ?').run(
      patch.title !== undefined ? cleanTitle(patch.title) : a.title,
      patch.para !== undefined ? assertPara(patch.para) : a.para,
      patch.folder !== undefined ? sanitizeFolder(patch.folder) : a.folder,
      clock().toISOString(), a.id);
    return get(a.id);
  }

  function remove(id) {
    const a = row(id);
    const dir = abs(dirRel(a.id));
    if (fs.existsSync(dir)) {
      const trash = path.join(vaultDir, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(dir, path.join(trash, `${clock().toISOString().replace(/[:.]/g, '-')} apostila ${sanitizeSegment(a.title)}`));
    }
    db.prepare('DELETE FROM apostilas WHERE id = ?').run(a.id);
    return { ok: true };
  }

  function decodeJpeg(base64) {
    const buf = Buffer.from(String(base64 ?? '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (!buf.length) throw httpError(400, 'Imagem vazia.');
    if (buf.length > MAX_IMAGE_BYTES) throw httpError(413, 'Imagem grande demais (limite 15 MB).');
    let info;
    try { info = jpegInfo(buf); } catch (err) { throw httpError(400, err.message); }
    return { buf, info };
  }

  function writeImage(apostilaId, suffix, buf) {
    const rel = `${dirRel(apostilaId)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}${suffix}.jpg`;
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), buf);
    return rel;
  }

  const unlinkQuiet = (rel) => { try { fs.rmSync(abs(rel)); } catch { /* já removido */ } };

  async function addPage(id, { image, name = '' }) {
    const a = row(id);
    const { buf, info } = decodeJpeg(image);
    const rel = writeImage(a.id, '', buf);
    const ord = (db.prepare('SELECT MAX(ord) AS m FROM apostila_pages WHERE apostila_id = ?').get(a.id).m ?? -1) + 1;
    db.prepare(`INSERT INTO apostila_pages (apostila_id, file, original, ord, width, height, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, rel, rel, ord, info.width, info.height, String(name).slice(0, 200), clock().toISOString());
    touch(a.id);
    return get(a.id);
  }

  function page(id, pageId) {
    const p = db.prepare('SELECT * FROM apostila_pages WHERE id = ? AND apostila_id = ?').get(Number(pageId), String(id));
    if (!p) throw httpError(404, 'Página não encontrada.');
    return p;
  }

  // O navegador gira a imagem ORIGINAL e manda o resultado: no máximo uma recompressão,
  // e o OCR/PDF recebem a página já na orientação certa.
  async function rotatePage(id, pageId, { image, rotation }) {
    const p = page(id, pageId);
    const rot = ((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360;
    let file = p.original;
    let { width, height } = jpegInfo(fs.readFileSync(abs(p.original)));
    if (rot !== 0) {
      const { buf, info } = decodeJpeg(image);
      file = writeImage(id, `-r${rot}`, buf);
      ({ width, height } = info);
    }
    if (p.file !== p.original && p.file !== file) unlinkQuiet(p.file);
    db.prepare('UPDATE apostila_pages SET file = ?, rotation = ?, width = ?, height = ?, ocr_text = NULL WHERE id = ?')
      .run(file, rot, width, height, p.id);
    touch(id);
    return get(id);
  }

  async function reorder(id, pageIds) {
    const a = row(id);
    const current = pagesOf(a.id).map((p) => p.id);
    const wanted = (pageIds || []).map(Number);
    if (wanted.length !== current.length || !current.every((pid) => wanted.includes(pid))) throw httpError(400, 'Ordem inválida.');
    const upd = db.prepare('UPDATE apostila_pages SET ord = ? WHERE id = ?');
    wanted.forEach((pid, i) => upd.run(i, pid));
    touch(a.id);
    return get(a.id);
  }

  async function deletePage(id, pageId) {
    const p = page(id, pageId);
    unlinkQuiet(p.file);
    if (p.original !== p.file) unlinkQuiet(p.original);
    db.prepare('DELETE FROM apostila_pages WHERE id = ?').run(p.id);
    const upd = db.prepare('UPDATE apostila_pages SET ord = ? WHERE id = ?');
    pagesOf(id).forEach((x, i) => upd.run(i, x.id));
    touch(id);
    return get(id);
  }

  async function ocrPage(id, pageId) {
    const p = page(id, pageId);
    const text = await ocr.ocrImage(abs(p.file));
    db.prepare('UPDATE apostila_pages SET ocr_text = ? WHERE id = ?').run(text, p.id);
    return { id: p.id, text };
  }

  function ocrSection(pages) {
    const parts = pages.map((p, i) => (p.ocr_text ? `### Página ${i + 1}\n\n${p.ocr_text}` : null)).filter(Boolean);
    return parts.length ? `${OCR_HEADING}\n\n${parts.join('\n\n')}\n` : '';
  }

  // Gera (ou regenera) o PDF e cria/atualiza a nota que aponta para ele.
  async function generate(id, { includeOcr = false } = {}) {
    const a = row(id);
    const pages = pagesOf(a.id);
    if (!pages.length) throw httpError(400, 'Adicione pelo menos uma página.');
    const pdf = buildPdf(pages.map((p) => fs.readFileSync(abs(p.file))), { title: a.title, created: clock() });

    const dir = [PARA[a.para].dir, a.folder].filter(Boolean).join('/');
    const pdfRel = uniquePath(vaultDir, `${dir}/${sanitizeSegment(a.title) || 'Apostila'}.pdf`, a.pdf_path);
    fs.mkdirSync(path.dirname(abs(pdfRel)), { recursive: true });
    fs.writeFileSync(abs(pdfRel), pdf);
    if (a.pdf_path && a.pdf_path !== pdfRel) unlinkQuiet(a.pdf_path);

    const ocrText = includeOcr ? ocrSection(pages) : '';
    let note;
    if (noteExists(a.note_id)) {
      note = notes.getNote(a.note_id);
      const link = relativeLink(note.path, pdfRel);
      let body = note.body;
      if (a.link_target && a.link_target !== link) body = body.split(`](${a.link_target})`).join(`](${link})`);
      body = body.replace(/· \d+ páginas?/, `· ${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}`);
      if (ocrText) {
        const at = body.indexOf(OCR_HEADING);
        body = at === -1 ? `${body.trimEnd()}\n\n${ocrText}` : `${body.slice(0, at)}${ocrText}`;
      }
      note = notes.updateNote(note.id, { body });
      db.prepare('UPDATE apostilas SET link_target = ? WHERE id = ?').run(link, a.id);
    } else {
      const notePathGuess = `${dir}/${sanitizeSegment(a.title)}.md`;
      const link = relativeLink(notePathGuess, pdfRel);
      note = notes.createNote({
        title: a.title, para: a.para, folder: a.folder,
        body: [
          `# ${a.title}`, '',
          `📄 [Abrir o PDF da apostila](${link}) · ${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}`, '',
          '## Resumo', '',
          'Escreva com suas palavras as ideias principais da apostila.', '',
          '## Flashcards', '',
          'Pergunta :: Resposta', '',
          ocrText
        ].join('\n')
      });
      // a nota pode ter ganhado sufixo " (2)": recalcula o link a partir do caminho real
      const realLink = relativeLink(note.path, pdfRel);
      if (realLink !== link) note = notes.updateNote(note.id, { body: note.body.split(`](${link})`).join(`](${realLink})`) });
      db.prepare('UPDATE apostilas SET note_id = ?, link_target = ? WHERE id = ?').run(note.id, realLink, a.id);
    }
    const now = clock().toISOString();
    db.prepare('UPDATE apostilas SET pdf_path = ?, generated_at = ?, updated_at = ? WHERE id = ?').run(pdfRel, now, now, a.id);
    return { pdfPath: pdfRel, pdfUrl: fileUrl(pdfRel), noteId: note.id, bytes: pdf.length };
  }

  function pdfAbsPath(id) {
    const a = row(id);
    if (!a.pdf_path || !fs.existsSync(abs(a.pdf_path))) throw httpError(404, 'O PDF ainda não foi gerado.');
    return abs(a.pdf_path);
  }

  return { list, get, create, update, remove, addPage, rotatePage, reorder, deletePage, ocrPage, generate, pdfAbsPath };
}

// Link Markdown relativo à pasta da nota, com cada trecho codificado (compatível com Obsidian).
export function relativeLink(notePath, targetPath) {
  const rel = path.posix.relative(path.posix.dirname(notePath), targetPath);
  return rel.split('/').map((seg) => (seg === '..' ? seg : encodeURIComponent(seg))).join('/');
}
