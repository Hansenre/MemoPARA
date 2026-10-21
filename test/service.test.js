import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDatabase } from '../src/db.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { parseFlashcards, sanitizeFolder, splitFrontMatter } from '../src/vault.js';

const DAY = 86_400_000;
let dir, vault, db, service, now;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memopara-'));
  vault = path.join(dir, 'vault');
  db = openDatabase(path.join(dir, 'test.db'));
  now = new Date('2026-03-10T12:00:00');
  service = createService({ db, vaultDir: vault, clock: () => now, random: () => 0.5 });
});

test('parseFlashcards reads "q :: a" lines outside code blocks', () => {
  const cards = parseFlashcards('# T\n- Capital da França :: Paris\n```\nx :: y\n```\n1. 2+2 :: 4\nsem cartão');
  assert.deepEqual(cards.map((c) => [c.prompt, c.answer]), [['Capital da França', 'Paris'], ['2+2', '4']]);
});

test('sanitizeFolder blocks traversal', () => {
  assert.equal(sanitizeFolder('../a/./b\\..\\c'), 'a/b/c');
  assert.equal(sanitizeFolder('x:y/z*'), 'x y/z');
});

test('front matter keeps id and other metadata', () => {
  const { meta, body } = splitFrontMatter('---\nmemopara: abc\ntags: x\n---\n\n# Oi\n');
  assert.deepEqual(meta, ['memopara: abc', 'tags: x']);
  assert.equal(body, '# Oi\n');
});

test('creating a note writes the file and schedules cards for the next study day', () => {
  const note = service.createNote({ title: 'Fotossíntese', para: 'resources', folder: 'Biologia/Plantas', body: 'Clorofila :: pigmento verde' });
  assert.equal(note.path, 'Resources/Biologia/Plantas/Fotossíntese.md');
  const raw = fs.readFileSync(path.join(vault, note.path), 'utf8');
  assert.match(raw, new RegExp(`memopara: ${note.id}`));
  assert.equal(note.cards.length, 2);
  assert.equal(service.queue().cards.length, 0);
  now = new Date(now.getTime() + DAY);
  assert.equal(service.queue().cards.length, 2);
});

test('reviewing updates the card and preserves schedule across edits', () => {
  service.updateSettings({ firstReviewDelayDays: 0 });
  const note = service.createNote({ title: 'A', body: 'P1 :: R1' });
  const qa = note.cards.find((c) => c.kind === 'qa');
  const res = service.reviewCard(qa.id, { rating: 3, confidence: 3 });
  assert.equal(res.next.intervalDays, 3);
  const edited = service.updateNote(note.id, { body: 'P1 :: R1 corrigida\nP2 :: R2' });
  const p1 = edited.cards.find((c) => c.prompt === 'P1');
  assert.equal(p1.id, qa.id);
  assert.equal(p1.answer, 'R1 corrigida');
  assert.equal(p1.reps, 1);
  assert.equal(edited.cards.length, 3);
});

test('overconfident lapse shows up as a metacognition alert', () => {
  service.updateSettings({ firstReviewDelayDays: 0 });
  const note = service.createNote({ title: 'B', body: 'texto' });
  const r = service.reviewCard(note.cards[0].id, { rating: 1, confidence: 4 });
  assert.equal(r.overconfident, true);
  const dash = service.dashboard();
  assert.equal(dash.alerts.length, 1);
  service.resolveAlert(dash.alerts[0].id);
  assert.equal(service.dashboard().alerts.length, 0);
});

test('moving/renaming moves the file; archiving suspends cards', () => {
  const note = service.createNote({ title: 'C', para: 'inbox', body: 'x' });
  const moved = service.updateNote(note.id, { title: 'C2', para: 'projects', folder: 'TCC' });
  assert.equal(moved.path, 'Projects/TCC/C2.md');
  assert.ok(!fs.existsSync(path.join(vault, note.path)));
  const archived = service.updateNote(note.id, { para: 'archives' });
  assert.ok(archived.cards.every((c) => c.suspended === 1));
});

test('syncVault imports external files and follows renames by id', () => {
  fs.mkdirSync(path.join(vault, 'Areas', 'Saúde'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Areas', 'Saúde', 'Sono.md'), '# Sono\nREM :: fase dos sonhos');
  assert.equal(service.syncVault().added, 1);
  const [note] = service.listNotes({ q: 'sonhos' });
  assert.equal(note.title, 'Sono');
  fs.renameSync(path.join(vault, note.path), path.join(vault, 'Resources', 'Sono e memória.md'));
  const stats = service.syncVault();
  assert.equal(stats.moved, 1);
  const after = service.getNote(note.id);
  assert.equal(after.para, 'resources');
  assert.equal(after.title, 'Sono e memória');
});

test('new-card daily limit is respected', () => {
  service.updateSettings({ firstReviewDelayDays: 0, newPerDay: 2 });
  service.createNote({ title: 'D', body: 'a :: 1\nb :: 2\nc :: 3' });
  const q = service.queue();
  assert.equal(q.cards.length, 2);
  service.reviewCard(q.cards[0].id, { rating: 3 });
  assert.equal(service.queue().counts.new, 1);
});

test('export/import roundtrip', () => {
  const note = service.createNote({ title: 'E', body: 'x :: y' });
  const dump = service.exportAll();
  service.deleteNote(note.id);
  assert.equal(service.listNotes().length, 0);
  service.importAll(dump);
  assert.equal(service.getNote(note.id).cards.length, 2);
});

test('HTTP API rejects foreign hosts and non-JSON posts', async () => {
  const server = http.createServer(createApp({ service, paths: { vaultDir: vault } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (opts, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.end(body);
  });
  assert.equal((await call({ path: '/api/health' })).status, 200);
  assert.equal((await call({ path: '/api/health', headers: { Host: 'evil.com' } })).status, 403);
  assert.equal((await call({ path: '/api/notes', method: 'POST', headers: { 'Content-Type': 'text/plain' } }, '{}')).status, 415);
  const created = await call({ path: '/api/notes', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ title: 'Via API' }));
  assert.equal(created.status, 200);
  assert.equal((await call({ path: '/api/notes/nope' })).status, 404);
  server.close();
});
