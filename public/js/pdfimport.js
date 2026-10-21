// Importação de PDF: o texto é extraído aqui no navegador com o pdf.js (incluído em /vendor).
// PDFs digitalizados (só imagem) podem passar pelo OCR do Tesseract, se instalado.
import { api, h, $, toast } from './ui.js';
import { esc } from './md.js';

const VENDOR = '/vendor/pdfjs';
const MAX_BYTES = 100 * 1024 * 1024;
let pdfjsPromise = null;

function loadPdfjs() {
  pdfjsPromise ??= import(`${VENDOR}/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${VENDOR}/pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

// Reconstrói linhas e parágrafos a partir das posições dos trechos de texto.
export function textFromItems(items) {
  let out = '';
  let last = null;
  // garante que o texto termine com n quebras de linha (sem acumular quebras duplicadas)
  const breakLine = (n) => {
    out = out.replace(/[ \t]+$/, '');
    const have = out.match(/\n*$/)[0].length;
    if (out && have < n) out += '\n'.repeat(n - have);
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    // o pdf.js marca fim de linha com itens vazios (hasEOL), já posicionados na linha seguinte
    if (!it.str) { if (it.hasEOL) breakLine(1); continue; }
    const [, , , , x, y] = it.transform;
    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    if (last) {
      const dy = Math.abs(y - last.y);
      const lineGap = Math.max(size, last.size);
      if (dy > lineGap * 1.75) breakLine(2);
      else if (dy > lineGap * 0.4) breakLine(1);
      else if (x - last.end > size * 0.12 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    if (it.hasEOL) breakLine(1);
    last = { y, size, end: x + (it.width || 0) };
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

async function extract(file, { onStep, useOcr }) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({
    data: data.slice(), // o pdf.js transfere o buffer para o worker; mantemos uma cópia para o envio
    cMapUrl: `${VENDOR}/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${VENDOR}/standard_fonts/`,
    isEvalSupported: false
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onStep(`Lendo o texto: página ${n} de ${doc.numPages}`, n / doc.numPages);
    const page = await doc.getPage(n);
    pages.push(textFromItems((await page.getTextContent()).items));
    page.cleanup();
  }
  // poucos caracteres por página = PDF digitalizado
  const scanned = pages.reduce((a, t) => a + t.replace(/\s/g, '').length, 0) / doc.numPages < 25;
  let ocrUsed = false;
  if (scanned && useOcr) {
    ocrUsed = true;
    for (let n = 1; n <= doc.numPages; n++) {
      if (pages[n - 1].replace(/\s/g, '').length >= 25) continue;
      onStep(`OCR: página ${n} de ${doc.numPages} (pode demorar)`, n / doc.numPages);
      try { pages[n - 1] = (await api('/api/ocr', { method: 'POST', body: { image: await renderPageJpeg(doc, n) } })).text; }
      catch (err) { toast(`OCR da página ${n}: ${err.message}`, 'error'); }
    }
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { data, pages, pageCount, scanned, ocrUsed };
}

async function renderPageJpeg(doc, n) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const titleFromName = (name) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Documento';

// Importa uma lista de PDFs para a pasta indicada; devolve as notas criadas.
export async function importPdfFiles(files, { para = 'inbox', folder = '' } = {}) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return [];
  const ocr = await api('/api/ocr/status').catch(() => ({ available: false }));
  const dlg = h(`<dialog class="dialog import-progress">
    <h2>Importando PDF</h2>
    <p data-file class="muted"></p>
    <div class="progress"><i></i></div>
    <small data-step class="muted"></small>
  </dialog>`);
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // não fecha no Esc durante a importação
  document.body.append(dlg);
  dlg.showModal();
  const created = [];
  try {
    for (const [i, file] of pdfs.entries()) {
      $('[data-file]', dlg).innerHTML = `${pdfs.length > 1 ? `${i + 1} de ${pdfs.length}: ` : ''}<strong>${esc(file.name)}</strong>`;
      if (file.size > MAX_BYTES) { toast(`${file.name}: maior que 100 MB.`, 'error'); continue; }
      const onStep = (text, ratio) => {
        $('[data-step]', dlg).textContent = text;
        $('.progress i', dlg).style.width = `${Math.round(ratio * 100)}%`;
      };
      try {
        const r = await extract(file, { onStep, useOcr: ocr.available });
        onStep('Salvando o PDF e criando a nota…', 1);
        const res = await api('/api/pdf-import', {
          method: 'POST',
          body: { title: titleFromName(file.name), para, folder, pdf: toBase64(r.data), pages: r.pages, pageCount: r.pageCount, ocr: r.ocrUsed }
        });
        created.push({ ...res, scanned: r.scanned, ocrUsed: r.ocrUsed });
        if (r.scanned && !r.ocrUsed) toast(`${file.name}: PDF digitalizado, sem texto. A nota foi criada; instale o Tesseract para extrair o texto.`, 'error', 7000);
      } catch (err) {
        toast(`${file.name}: ${/password/i.test(err.name + err.message) ? 'PDF protegido por senha.' : err.message}`, 'error', 6000);
      }
    }
  } finally {
    dlg.close();
    dlg.remove();
  }
  return created;
}
