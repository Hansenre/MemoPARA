import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createPdfImporter, cleanText } from '../src/pdfimport.js';
import { buildPdf } from '../src/pdf.js';
import { textFromItems } from '../public/js/pdfimport.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const samplePdf = buildPdf([fs.readFileSync(path.join(FIX, 'portrait.jpg'))]).toString('base64');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memopara-pdf-'));
  const vault = path.join(dir, 'vault');
  const notes = createService({ db: openDatabase(path.join(dir, 't.db')), vaultDir: vault });
  return { vault, notes, importer: createPdfImporter({ vaultDir: vault, notes }) };
}

test('importing a PDF stores it next to an editable note with the text', () => {
  const { vault, notes, importer } = setup();
  const r = importer.importPdf({
    title: 'Contrato de Estágio', para: 'projects', folder: 'Estágio', pdf: samplePdf,
    pages: ['Cláusula primeira: o estagiário…', '', 'Cláusula terceira'], pageCount: 3
  });
  assert.equal(r.pdfPath, 'Projects/Estágio/Contrato de Estágio.pdf');
  assert.ok(fs.readFileSync(path.join(vault, r.pdfPath)).subarray(0, 5).toString() === '%PDF-');
  const note = notes.getNote(r.noteId);
  assert.equal(note.path, 'Projects/Estágio/Contrato de Estágio.md');
  assert.match(note.body, /\[Abrir o PDF original\]\(Contrato%20de%20Est%C3%A1gio\.pdf\) · 3 páginas/);
  assert.match(note.body, /### Página 1\n\nCláusula primeira/);
  assert.doesNotMatch(note.body, /### Página 2/, 'página sem texto é omitida');
  assert.match(note.body, /### Página 3/);
  assert.equal(notes.listNotes({ q: 'clausula' }).length, 1, 'texto pesquisável (sem acento também)');
  // a nota continua editável normalmente
  const edited = notes.updateNote(r.noteId, { body: note.body.replace('Escreva com suas palavras as ideias principais.', 'Prazo de 6 meses.') });
  assert.match(edited.body, /Prazo de 6 meses\./);
});

test('importing twice with the same name keeps both, each note linking to its own PDF', () => {
  const { notes, importer } = setup();
  importer.importPdf({ title: 'Aula', pdf: samplePdf, pages: ['a'] });
  const second = importer.importPdf({ title: 'Aula', pdf: samplePdf, pages: ['b'] });
  assert.equal(second.pdfPath, 'Inbox/Aula (2).pdf');
  assert.match(notes.getNote(second.noteId).body, /\]\(Aula%20%282%29\.pdf\)/);
});

test('scanned PDF without text still creates the note with guidance', () => {
  const { notes, importer } = setup();
  const r = importer.importPdf({ title: 'Escaneado', pdf: samplePdf, pages: ['', ''], pageCount: 2 });
  assert.match(notes.getNote(r.noteId).body, /não tem texto selecionável/);
});

test('rejects files that are not PDFs', () => {
  const { importer } = setup();
  assert.throws(() => importer.importPdf({ title: 'x', pdf: Buffer.from('hello world').toString('base64') }), /não é um PDF/);
});

test('cleanText joins hyphenated words and neutralizes markdown/flashcard syntax', () => {
  assert.equal(cleanText('exem-\nplo de texto'), 'exemplo de texto');
  assert.equal(cleanText('a :: b'), 'a : b');
  assert.equal(cleanText('# Título\n```code'), '​# Título\n​```code');
  assert.equal(cleanText('a\n\n\n\nb'), 'a\n\nb');
});

test('textFromItems rebuilds lines, spaces and paragraphs from pdf.js items', () => {
  const it = (str, x, y, width, extra = {}) => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, ...extra });
  const text = textFromItems([
    it('Olá', 10, 700, 20), it('mundo', 34, 700, 30), // mesma linha, com espaço
    it('segunda linha', 10, 686, 80),                 // nova linha
    it('novo parágrafo', 10, 640, 90)                 // salto grande = parágrafo
  ]);
  assert.equal(text, 'Olá mundo\nsegunda linha\n\nnovo parágrafo');
});

test('textFromItems handles pdf.js empty end-of-line markers without doubling breaks', () => {
  const it = (str, y, size, width, eol = false) => ({ str, transform: [size, 0, 0, size, 72, y], width, height: str ? size : 0, hasEOL: eol });
  // formato real emitido pelo pdf.js 4.x: o marcador vazio vem antes da linha seguinte, na mesma altura dela
  const text = textFromItems([
    it('Ciclo de Krebs', 762, 20, 130),
    it('', 722, 11, 0, true), it('O ciclo ocorre na matriz,', 722, 11, 300),
    it('', 706, 11, 0, true), it('produz NADH e FADH2.', 706, 11, 300),
    it('', 674, 11, 0, true), it('Etapas principais.', 674, 11, 300)
  ]);
  assert.equal(text, 'Ciclo de Krebs\n\nO ciclo ocorre na matriz,\nproduz NADH e FADH2.\n\nEtapas principais.');
});
