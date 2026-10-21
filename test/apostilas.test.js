import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createApostilaService, relativeLink } from '../src/apostilas.js';
import { buildPdf, jpegInfo } from '../src/pdf.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const portrait = fs.readFileSync(path.join(FIX, 'portrait.jpg'));
const landscape = fs.readFileSync(path.join(FIX, 'landscape.jpg'));
const b64 = (buf) => buf.toString('base64');

let vault, notes, apostilas, ocrCalls;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memopara-ap-'));
  vault = path.join(dir, 'vault');
  const db = openDatabase(path.join(dir, 'test.db'));
  notes = createService({ db, vaultDir: vault });
  ocrCalls = 0;
  const fakeOcr = {
    detectTesseract: async () => ({ available: true, version: 'fake', langs: ['por'] }),
    ocrImage: async () => `texto da página ${++ocrCalls}`
  };
  apostilas = createApostilaService({ db, vaultDir: vault, notes, ocr: fakeOcr });
});

test('jpegInfo reads dimensions and rejects non-JPEG', () => {
  assert.deepEqual(jpegInfo(portrait), { width: 30, height: 40, components: 3 });
  assert.throws(() => jpegInfo(Buffer.from('not a jpeg')), /JPEG/);
});

test('buildPdf writes a valid PDF with one page per image and correct xref', () => {
  const pdf = buildPdf([portrait, landscape], { title: 'Apostila de Física' });
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 2);
  assert.match(text, /\/MediaBox \[0 0 595\.28 793\.71\]/); // retrato: largura A4
  assert.match(text, /\/MediaBox \[0 0 841\.89 561\.26\]/); // paisagem: lado maior do A4
  // cada entrada da tabela xref aponta exatamente para "N 0 obj"
  const xrefAt = Number(text.match(/startxref\n(\d+)/)[1]);
  const entries = text.slice(xrefAt).split('\n').slice(3).filter((l) => / 00000 n $/.test(l));
  entries.forEach((line, i) => {
    const expected = `${i + 1} 0 obj\n`;
    const at = Number(line.slice(0, 10));
    assert.equal(text.slice(at, at + expected.length), expected);
  });
});

test('pages can be added, rotated, reordered and removed', async () => {
  const a = await apostilas.create({ title: 'Cálculo I', para: 'areas', folder: 'Faculdade' });
  await apostilas.addPage(a.id, { image: b64(portrait), name: 'IMG_1.jpg' });
  let s = await apostilas.addPage(a.id, { image: `data:image/jpeg;base64,${b64(landscape)}`, name: 'IMG_2.jpg' });
  assert.equal(s.pages.length, 2);
  assert.ok(fs.existsSync(path.join(vault, s.pages[0].file)));

  const [p1, p2] = s.pages;
  s = await apostilas.rotatePage(a.id, p2.id, { image: b64(portrait), rotation: 90 });
  const rotated = s.pages.find((p) => p.id === p2.id);
  assert.equal(rotated.rotation, 90);
  assert.notEqual(rotated.file, rotated.original);
  assert.equal(rotated.width, 30);
  s = await apostilas.rotatePage(a.id, p2.id, { rotation: 0 });
  assert.equal(s.pages.find((p) => p.id === p2.id).file, rotated.original);
  assert.ok(!fs.existsSync(path.join(vault, rotated.file)), 'arquivo girado antigo é apagado');

  s = await apostilas.reorder(a.id, [p2.id, p1.id]);
  assert.deepEqual(s.pages.map((p) => p.id), [p2.id, p1.id]);
  await assert.rejects(apostilas.reorder(a.id, [p1.id]), /Ordem inválida/);

  s = await apostilas.deletePage(a.id, p2.id);
  assert.deepEqual(s.pages.map((p) => [p.id, p.ord]), [[p1.id, 0]]);
});

test('generate creates the PDF in the PARA folder and a linked study note', async () => {
  const a = await apostilas.create({ title: 'Química Orgânica', para: 'resources', folder: 'Química' });
  await apostilas.addPage(a.id, { image: b64(portrait) });
  const s = await apostilas.addPage(a.id, { image: b64(landscape) });
  for (const p of s.pages) await apostilas.ocrPage(a.id, p.id);

  const r = await apostilas.generate(a.id, { includeOcr: true });
  assert.equal(r.pdfPath, 'Resources/Química/Química Orgânica.pdf');
  assert.ok(fs.readFileSync(path.join(vault, r.pdfPath)).toString('latin1').startsWith('%PDF'));
  const note = notes.getNote(r.noteId);
  assert.equal(note.path, 'Resources/Química/Química Orgânica.md');
  assert.match(note.body, /\[Abrir o PDF da apostila\]\(Qu%C3%ADmica%20Org%C3%A2nica\.pdf\) · 2 páginas/);
  assert.match(note.body, /### Página 2\n\ntexto da página 2/);
  assert.ok(notes.listNotes({ q: 'texto' }).length === 1, 'texto do OCR fica pesquisável');

  // regenerar depois de renomear e de o usuário editar a nota: mantém o texto dele e corrige o link
  notes.updateNote(r.noteId, { body: note.body.replace('Escreva com suas palavras as ideias principais da apostila.', 'Meu resumo.') });
  await apostilas.update(a.id, { title: 'Orgânica' });
  const r2 = await apostilas.generate(a.id, { includeOcr: false });
  assert.equal(r2.noteId, r.noteId);
  assert.equal(r2.pdfPath, 'Resources/Química/Orgânica.pdf');
  assert.ok(!fs.existsSync(path.join(vault, r.pdfPath)), 'PDF antigo removido');
  const after = notes.getNote(r.noteId).body;
  assert.match(after, /Meu resumo\./);
  assert.match(after, /\]\(Org%C3%A2nica\.pdf\)/);
});

test('generate without pages fails clearly; delete keeps PDF and note', async () => {
  const a = await apostilas.create({ title: 'Vazia' });
  await assert.rejects(apostilas.generate(a.id), /pelo menos uma página/);
  await apostilas.addPage(a.id, { image: b64(portrait) });
  const r = await apostilas.generate(a.id);
  apostilas.remove(a.id);
  assert.equal(apostilas.list().length, 0);
  assert.ok(fs.existsSync(path.join(vault, r.pdfPath)));
  assert.equal(notes.getNote(r.noteId).title, 'Vazia');
});

test('relativeLink encodes segments and walks up folders', () => {
  assert.equal(relativeLink('Areas/A/nota.md', 'Areas/A/Meu PDF.pdf'), 'Meu%20PDF.pdf');
  assert.equal(relativeLink('Projects/x.md', 'Resources/Bio/a b.pdf'), '../Resources/Bio/a%20b.pdf');
});
