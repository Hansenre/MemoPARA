// Importa um PDF existente: guarda o arquivo na pasta PARA e cria uma nota editável
// com o texto extraído (o navegador extrai o texto com pdf.js e manda por página).
import fs from 'node:fs';
import path from 'node:path';
import { PARA, assertPara, sanitizeFolder, sanitizeSegment, resolveInside, uniquePath, httpError } from './vault.js';
import { relativeLink } from './apostilas.js';

const MAX_TEXT = 1_500_000;

export function createPdfImporter({ vaultDir, notes }) {
  function importPdf({ title, para = 'inbox', folder = '', pdf, pages = [], ocr = false, pageCount }) {
    title = String(title ?? '').trim().slice(0, 150);
    if (!title) throw httpError(400, 'Informe um título.');
    assertPara(para);
    folder = sanitizeFolder(folder);
    const buf = Buffer.from(String(pdf ?? '').replace(/^data:application\/pdf;base64,/, ''), 'base64');
    if (buf.length < 8 || buf.subarray(0, 1024).indexOf('%PDF-') === -1) throw httpError(400, 'O arquivo não é um PDF válido.');
    const texts = (Array.isArray(pages) ? pages : []).map((t) => cleanText(String(t ?? '')));
    const total = Number(pageCount) || texts.length;

    const dir = [PARA[para].dir, folder].filter(Boolean).join('/');
    const pdfRel = uniquePath(vaultDir, `${dir}/${sanitizeSegment(title) || 'Documento'}.pdf`);
    fs.mkdirSync(path.dirname(resolveInside(vaultDir, pdfRel)), { recursive: true });
    fs.writeFileSync(resolveInside(vaultDir, pdfRel), buf);

    const placeholder = '\u0000link\u0000';
    const body = buildBody({ title, link: placeholder, total, texts, ocr });
    let note = notes.createNote({ title, para, folder, body: body.replace(placeholder, relativeLink(`${dir}/x.md`, pdfRel)) });
    const link = relativeLink(note.path, pdfRel);
    if (!note.body.includes(`](${link})`)) {
      note = notes.updateNote(note.id, { body: body.replace(placeholder, link) });
    }
    return { noteId: note.id, notePath: note.path, pdfPath: pdfRel, pages: total, chars: texts.reduce((a, t) => a + t.length, 0) };
  }

  return { importPdf };
}

export function cleanText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2') // junta palavras hifenizadas na quebra de linha
    .split('\n')
    .map((l) => l.replace(/\s+$/, '')
      .replace(/\s::\s/g, ' : ') // não deixa o texto do PDF virar flashcard sem querer
      .replace(/^(\s*)(#|```|~~~)/, '$1​$2')) // nem título/bloco de código de Markdown
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildBody({ title, link, total, texts, ocr }) {
  const lines = [
    `# ${title}`, '',
    `📄 [Abrir o PDF original](${link}) · ${total} ${total === 1 ? 'página' : 'páginas'}`, '',
    '## Resumo', '',
    'Escreva com suas palavras as ideias principais.', '',
    '## Flashcards', '',
    'Pergunta :: Resposta', '',
    `## Conteúdo do PDF${ocr ? ' (OCR)' : ''}`, ''
  ];
  let used = 0;
  let any = false;
  texts.forEach((t, i) => {
    if (!t || used > MAX_TEXT) return;
    const chunk = t.slice(0, MAX_TEXT - used);
    used += chunk.length;
    any = true;
    lines.push(`### Página ${i + 1}`, '', chunk, '');
  });
  if (used > MAX_TEXT) lines.push('_(texto cortado: o PDF é grande demais para caber inteiro na nota)_', '');
  if (!any) lines.push('_Este PDF não tem texto selecionável (provavelmente é digitalizado). Instale o Tesseract para extrair o texto das páginas, ou escreva o conteúdo aqui._', '');
  return lines.join('\n');
}
