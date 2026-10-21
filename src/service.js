import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transaction } from './db.js';
import { FSRS, State, retrievability } from './fsrs.js';
import {
  PARA, assertPara, sanitizeSegment, sanitizeFolder, resolveInside, hash, httpError,
  readNoteFile, writeNoteFile, parseFlashcards, titleFromBody, notePath, uniquePath,
  locate, ensureVault, walkNotes, listFolders
} from './vault.js';

const DAY_MS = 86_400_000;
const DEFAULT_SETTINGS = {
  desiredRetention: 0.9,
  maxInterval: 36500,
  newPerDay: 20,
  firstReviewDelayDays: 1,
  dayRolloverHour: 4
};
const SETTING_LIMITS = {
  desiredRetention: [0.7, 0.99],
  maxInterval: [30, 36500],
  newPerDay: [0, 500],
  firstReviewDelayDays: [0, 30],
  dayRolloverHour: [0, 23]
};

export function createService({ db, vaultDir, clock = () => new Date(), random = Math.random }) {
  ensureVault(vaultDir);

  // ---------- configurações ----------
  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const s = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in s) s[r.key] = JSON.parse(r.value);
    return s;
  }

  function updateSettings(patch) {
    const upsert = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in SETTING_LIMITS)) continue;
      const [lo, hi] = SETTING_LIMITS[key];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(400, `Valor inválido para ${key} (${lo}–${hi}).`);
      upsert.run(key, JSON.stringify(key === 'desiredRetention' ? v : Math.round(v)));
    }
    return getSettings();
  }

  const scheduler = () => {
    const s = getSettings();
    return new FSRS({ desiredRetention: s.desiredRetention, maxInterval: s.maxInterval, random });
  };

  // Um "dia de estudo" começa na hora de virada (padrão 4h), como no Anki.
  function studyDayStart(now = clock()) {
    const { dayRolloverHour } = getSettings();
    const d = new Date(now);
    if (d.getHours() < dayRolloverHour) d.setDate(d.getDate() - 1);
    d.setHours(dayRolloverHour, 0, 0, 0);
    return d;
  }
  const studyDayKey = (date) => {
    const d = new Date(date);
    d.setHours(d.getHours() - getSettings().dayRolloverHour);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ---------- cartões ----------
  function syncCards(noteId, title, body, isNew) {
    const { firstReviewDelayDays } = getSettings();
    const firstDue = new Date(studyDayStart().getTime() + firstReviewDelayDays * DAY_MS).toISOString();
    const archived = db.prepare('SELECT para FROM notes WHERE id = ?').get(noteId)?.para === 'archives' ? 1 : 0;
    const wanted = [{ key: 'note', kind: 'note', prompt: title, answer: '' },
      ...parseFlashcards(body).map((c) => ({ ...c, kind: 'qa' }))];

    const existing = new Map(db.prepare('SELECT id, key FROM cards WHERE note_id = ?').all(noteId).map((r) => [r.key, r.id]));
    const insert = db.prepare(`INSERT INTO cards (note_id, key, kind, prompt, answer, ord, due, suspended)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare('UPDATE cards SET prompt = ?, answer = ?, ord = ? WHERE id = ?');
    wanted.forEach((c, i) => {
      if (existing.has(c.key)) update.run(c.prompt, c.answer, i, existing.get(c.key));
      else insert.run(noteId, c.key, c.kind, c.prompt, c.answer, i, isNew || c.kind === 'qa' ? firstDue : clock().toISOString(), archived);
      existing.delete(c.key);
    });
    const del = db.prepare('DELETE FROM cards WHERE id = ?');
    for (const id of existing.values()) del.run(id);
  }

  function indexNote(noteId, title, body) {
    db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId);
    db.prepare('INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
  }

  // ---------- notas ----------
  function getNoteRow(id) {
    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(String(id));
    if (!row) throw httpError(404, 'Nota não encontrada.');
    return row;
  }

  function readBody(row) {
    const abs = resolveInside(vaultDir, row.path);
    return fs.existsSync(abs) ? readNoteFile(abs).body : '';
  }

  function cleanTitle(title) {
    const t = String(title ?? '').trim().slice(0, 200);
    if (!t) throw httpError(400, 'Informe um título.');
    return t;
  }

  function createNote({ title, para = 'inbox', folder = '', body = '', loci = '' }) {
    title = cleanTitle(title);
    assertPara(para);
    folder = sanitizeFolder(folder);
    body = String(body ?? '');
    if (body.length > 2_000_000) throw httpError(413, 'Nota muito grande (limite 2 MB).');
    const id = crypto.randomUUID();
    const rel = uniquePath(vaultDir, notePath(para, folder, title));
    const now = clock().toISOString();
    writeNoteFile(resolveInside(vaultDir, rel), id, body, []);
    transaction(db, () => {
      db.prepare(`INSERT INTO notes (id, path, title, para, folder, loci, archived, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, rel, title, para, folder, String(loci ?? '').slice(0, 300), para === 'archives' ? 1 : 0, hash(body), now, now);
      syncCards(id, title, body, true);
      indexNote(id, title, body);
    });
    return getNote(id);
  }

  function updateNote(id, patch) {
    const row = getNoteRow(id);
    const title = patch.title !== undefined ? cleanTitle(patch.title) : row.title;
    const para = patch.para !== undefined ? assertPara(patch.para) : row.para;
    const folder = patch.folder !== undefined ? sanitizeFolder(patch.folder) : row.folder;
    const loci = patch.loci !== undefined ? String(patch.loci).slice(0, 300) : row.loci;
    const body = patch.body !== undefined ? String(patch.body) : readBody(row);
    if (body.length > 2_000_000) throw httpError(413, 'Nota muito grande (limite 2 MB).');

    let rel = row.path;
    const moved = title !== row.title || para !== row.para || folder !== row.folder;
    if (moved) rel = uniquePath(vaultDir, notePath(para, folder, title), row.path);
    const oldAbs = resolveInside(vaultDir, row.path);
    const newAbs = resolveInside(vaultDir, rel);
    const meta = fs.existsSync(oldAbs) ? readNoteFile(oldAbs).meta : [];
    writeNoteFile(newAbs, row.id, body, meta);
    if (newAbs !== oldAbs && fs.existsSync(oldAbs)) fs.rmSync(oldAbs);

    transaction(db, () => {
      db.prepare(`UPDATE notes SET path = ?, title = ?, para = ?, folder = ?, loci = ?, archived = ?, missing = 0,
        content_hash = ?, updated_at = ? WHERE id = ?`)
        .run(rel, title, para, folder, loci, para === 'archives' ? 1 : 0, hash(body), clock().toISOString(), row.id);
      syncCards(row.id, title, body, false);
      db.prepare('UPDATE cards SET suspended = ? WHERE note_id = ?').run(para === 'archives' ? 1 : 0, row.id);
      indexNote(row.id, title, body);
    });
    return getNote(row.id);
  }

  function deleteNote(id) {
    const row = getNoteRow(id);
    const abs = resolveInside(vaultDir, row.path);
    if (fs.existsSync(abs)) {
      // nunca apaga de verdade: vai para a lixeira do vault
      const trash = path.join(vaultDir, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = clock().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(abs, path.join(trash, `${stamp} ${path.basename(abs)}`));
    }
    transaction(db, () => {
      db.prepare('DELETE FROM notes WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(row.id);
    });
    return { ok: true };
  }

  function decorateCard(card, now = clock()) {
    const elapsed = card.last_review ? (now - new Date(card.last_review)) / DAY_MS : 0;
    return { ...card, retrievability: card.state === State.New ? null : retrievability(elapsed, card.stability) };
  }

  function getNote(id) {
    const row = getNoteRow(id);
    const cards = db.prepare('SELECT * FROM cards WHERE note_id = ? ORDER BY ord').all(row.id).map((c) => decorateCard(c));
    const history = db.prepare(`SELECT rating, confidence, reviewed_at, interval_days FROM reviews
      WHERE note_id = ? AND card_id = (SELECT id FROM cards WHERE note_id = ? AND key = 'note')
      ORDER BY reviewed_at DESC LIMIT 20`).all(row.id, row.id);
    return { ...row, body: readBody(row), cards, history };
  }

  function listNotes({ para, folder, q, limit = 200 } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (para) { where.push('n.para = ?'); args.push(assertPara(para)); }
    if (folder !== undefined && folder !== null && folder !== '') {
      where.push('(n.folder = ? OR n.folder LIKE ?)');
      const f = sanitizeFolder(folder);
      args.push(f, `${f}/%`);
    }
    let from = 'notes n';
    let order = 'n.updated_at DESC';
    const terms = String(q ?? '').match(/[\p{L}\p{N}_]+/gu);
    if (terms?.length) {
      from = 'notes_fts f JOIN notes n ON n.id = f.note_id';
      where.push('notes_fts MATCH ?');
      args.push(terms.slice(0, 8).map((t) => `"${t}"*`).join(' '));
      order = 'bm25(notes_fts, 0, 5, 1)';
    }
    const rows = db.prepare(`SELECT n.*, c.state, c.stability, c.last_review, c.due, c.reps, c.lapses,
        (SELECT COUNT(*) FROM cards x WHERE x.note_id = n.id AND x.kind = 'qa') AS qa_count
        ${terms?.length ? ", snippet(notes_fts, 2, '<<', '>>', '…', 12) AS snippet" : ''}
      FROM ${from} LEFT JOIN cards c ON c.note_id = n.id AND c.key = 'note'
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 500));
    const now = clock();
    return rows.map((r) => decorateCard(r, now));
  }

  function tree() {
    const folders = listFolders(vaultDir);
    const counts = db.prepare('SELECT para, folder, COUNT(*) AS n FROM notes GROUP BY para, folder').all();
    return Object.entries(PARA).map(([key, { label, dir }]) => ({
      key, label, dir,
      total: counts.filter((c) => c.para === key).reduce((a, c) => a + c.n, 0),
      folders: folders[key].map((f) => ({
        path: f,
        count: counts.filter((c) => c.para === key && (c.folder === f || c.folder.startsWith(`${f}/`))).reduce((a, c) => a + c.n, 0)
      }))
    }));
  }

  function createFolder(para, folder) {
    assertPara(para);
    const f = sanitizeFolder(folder);
    if (!f) throw httpError(400, 'Nome de pasta inválido.');
    fs.mkdirSync(resolveInside(vaultDir, `${PARA[para].dir}/${f}`), { recursive: true });
    return { para, folder: f };
  }

  // Lê o vault e reconcilia com o banco: arquivos novos viram notas, movidos são
  // relocalizados pelo id do front matter, editados fora do app têm os cartões refeitos.
  function syncVault() {
    const stats = { added: 0, moved: 0, updated: 0, missing: 0 };
    const seen = new Set();
    for (const rel of walkNotes(vaultDir)) {
      const { para, folder } = locate(rel);
      if (!para) continue;
      const abs = resolveInside(vaultDir, rel);
      let file;
      try { file = readNoteFile(abs); } catch { continue; }
      let row = file.id ? db.prepare('SELECT * FROM notes WHERE id = ?').get(file.id) : null;
      if (!row) row = db.prepare('SELECT * FROM notes WHERE path = ?').get(rel);
      if (row && seen.has(row.id)) row = null; // arquivo duplicado (cópia): vira nota nova

      if (!row) {
        const id = crypto.randomUUID();
        const title = path.basename(rel, path.extname(rel)) || titleFromBody(file.body, 'Nota');
        const now = clock().toISOString();
        writeNoteFile(abs, id, file.body, file.meta.filter((l) => !/^memopara:/.test(l)));
        transaction(db, () => {
          db.prepare(`INSERT INTO notes (id, path, title, para, folder, archived, content_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rel, title, para, folder, para === 'archives' ? 1 : 0, hash(file.body), now, now);
          syncCards(id, title, file.body, true);
          if (para === 'archives') db.prepare('UPDATE cards SET suspended = 1 WHERE note_id = ?').run(id);
          indexNote(id, title, file.body);
        });
        seen.add(id);
        stats.added++;
        continue;
      }
      seen.add(row.id);
      if (file.id !== row.id) writeNoteFile(abs, row.id, file.body, file.meta);
      const movedTo = row.path !== rel;
      const changed = hash(file.body) !== row.content_hash;
      if (movedTo || changed || row.missing) {
        const title = movedTo ? path.basename(rel, path.extname(rel)) : row.title;
        transaction(db, () => {
          db.prepare(`UPDATE notes SET path = ?, title = ?, para = ?, folder = ?, archived = ?, missing = 0, content_hash = ?, updated_at = ?
            WHERE id = ?`).run(rel, title, para, folder, para === 'archives' ? 1 : 0, hash(file.body), clock().toISOString(), row.id);
          syncCards(row.id, title, file.body, false);
          db.prepare('UPDATE cards SET suspended = ? WHERE note_id = ?').run(para === 'archives' ? 1 : 0, row.id);
          indexNote(row.id, title, file.body);
        });
        if (movedTo) stats.moved++; else stats.updated++;
      }
    }
    for (const row of db.prepare('SELECT id FROM notes WHERE missing = 0').all()) {
      if (seen.has(row.id)) continue;
      db.prepare('UPDATE notes SET missing = 1 WHERE id = ?').run(row.id);
      db.prepare('UPDATE cards SET suspended = 1 WHERE note_id = ?').run(row.id);
      stats.missing++;
    }
    return stats;
  }

  // ---------- revisão ----------
  function newIntroducedToday() {
    return db.prepare('SELECT COUNT(DISTINCT card_id) AS n FROM reviews WHERE state_before = 0 AND reviewed_at >= ?')
      .get(studyDayStart().toISOString()).n;
  }

  const CARD_SELECT = `SELECT c.*, n.title AS note_title, n.para, n.folder, n.loci, n.path
      FROM cards c JOIN notes n ON n.id = c.note_id`;

  function withPreview(cards, now = clock()) {
    const fsrs = scheduler();
    const bodies = new Map();
    return cards.map((c) => {
      if (c.kind === 'note' && !bodies.has(c.note_id)) bodies.set(c.note_id, readBody({ path: c.path }));
      return { ...decorateCard(c, now), body: c.kind === 'note' ? bodies.get(c.note_id) : undefined, preview: previewSummary(fsrs.preview(c, now)) };
    });
  }

  function cardForReview(cardId) {
    const card = db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(Number(cardId));
    if (!card) throw httpError(404, 'Cartão não encontrado.');
    return withPreview([card])[0];
  }

  function queue({ limit = 100, noteId = null } = {}) {
    const now = clock();
    if (noteId) {
      // revisão avulsa de uma nota: todos os cartões ativos dela, mesmo fora do prazo
      const cards = db.prepare(`${CARD_SELECT} WHERE c.note_id = ? AND c.suspended = 0 ORDER BY c.ord`).all(String(noteId));
      return { counts: { learning: 0, review: cards.length, new: 0 }, cards: withPreview(cards, now) };
    }
    const end = new Date(studyDayStart(now).getTime() + DAY_MS).toISOString();
    const settings = getSettings();
    const base = `${CARD_SELECT} WHERE c.suspended = 0 AND n.missing = 0 AND n.para != 'archives' AND c.due < ?`;
    const learning = db.prepare(`${base} AND c.state IN (1, 3) ORDER BY c.due`).all(end);
    const review = db.prepare(`${base} AND c.state = 2`).all(end).map((c) => decorateCard(c, now))
      .sort((a, b) => a.retrievability - b.retrievability); // o que está mais perto de ser esquecido primeiro
    const newLeft = Math.max(0, settings.newPerDay - newIntroducedToday());
    const fresh = db.prepare(`${base} AND c.state = 0 ORDER BY c.due, c.note_id, c.ord LIMIT ?`).all(end, newLeft);

    const items = [...learning, ...review, ...fresh].slice(0, Math.min(Number(limit) || 100, 500));
    return { counts: { learning: learning.length, review: review.length, new: fresh.length }, cards: withPreview(items, now) };
  }

  const previewSummary = (p) => Object.fromEntries(Object.entries(p).map(([g, r]) => [g, { intervalDays: r.intervalDays, due: r.due }]));

  function reviewCard(cardId, { rating, confidence = null, recallText = null, durationMs = null }) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId));
    if (!card) throw httpError(404, 'Cartão não encontrado.');
    const g = Number(rating);
    const conf = confidence == null || confidence === '' ? null : Number(confidence);
    if (conf !== null && ![1, 2, 3, 4].includes(conf)) throw httpError(400, 'Confiança deve ser de 1 a 4.');
    const now = clock();
    let next;
    try { next = scheduler().review(card, g, now); } catch (err) { throw httpError(400, err.message); }

    transaction(db, () => {
      db.prepare(`UPDATE cards SET state = ?, stability = ?, difficulty = ?, due = ?, last_review = ?,
        reps = reps + 1, lapses = lapses + ? WHERE id = ?`)
        .run(next.state, next.stability, next.difficulty, next.due, now.toISOString(),
          g === 1 && card.state === State.Review ? 1 : 0, card.id);
      db.prepare(`INSERT INTO reviews (card_id, note_id, rating, confidence, recall_text, state_before, elapsed_days,
        retrievability, stability_after, difficulty_after, interval_days, duration_ms, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(card.id, card.note_id, g, conf, recallText ? String(recallText).slice(0, 20000) : null, card.state,
          card.last_review ? next.elapsedDays : null, next.retrievability, next.stability, next.difficulty,
          next.intervalDays, Number.isFinite(Number(durationMs)) ? Math.min(Math.round(Number(durationMs)), 3_600_000) : null,
          now.toISOString());
    });
    const overconfident = conf !== null && conf >= 3 && g === 1;
    return { card: decorateCard(db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id), now), next, overconfident };
  }

  function resetCard(cardId) {
    const r = db.prepare(`UPDATE cards SET state = 0, stability = 0, difficulty = 0, last_review = NULL, reps = 0, lapses = 0, due = ?
      WHERE id = ?`).run(clock().toISOString(), Number(cardId));
    if (!r.changes) throw httpError(404, 'Cartão não encontrado.');
    return { ok: true };
  }

  function setCardSuspended(cardId, suspended) {
    const r = db.prepare('UPDATE cards SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, Number(cardId));
    if (!r.changes) throw httpError(404, 'Cartão não encontrado.');
    return { ok: true };
  }

  // ---------- painel ----------
  function dashboard() {
    const now = clock();
    const dayStart = studyDayStart(now);
    const settings = getSettings();
    const q = queue({ limit: 500 });
    const dueTotal = q.counts.learning + q.counts.review + q.counts.new;

    const forecast = [];
    const active = db.prepare(`SELECT c.due FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE c.suspended = 0 AND n.missing = 0 AND n.para != 'archives' AND c.due < ?`)
      .all(new Date(dayStart.getTime() + 30 * DAY_MS).toISOString());
    for (let i = 0; i < 30; i++) forecast.push({ date: studyDayKey(new Date(dayStart.getTime() + i * DAY_MS + 3_600_000 * 12)), count: 0 });
    for (const { due } of active) {
      const idx = Math.max(0, Math.floor((new Date(due) - dayStart) / DAY_MS));
      if (idx < 30) forecast[idx].count++;
    }

    const since = new Date(dayStart.getTime() - 364 * DAY_MS).toISOString();
    const recent = db.prepare('SELECT rating, confidence, state_before, retrievability, duration_ms, reviewed_at FROM reviews WHERE reviewed_at >= ?').all(since);
    const heat = {};
    for (const r of recent) { const k = studyDayKey(r.reviewed_at); heat[k] = (heat[k] || 0) + 1; }
    let streak = 0;
    for (let d = new Date(dayStart.getTime() + 12 * 3_600_000); ; d = new Date(d.getTime() - DAY_MS)) {
      const k = studyDayKey(d);
      if (heat[k]) streak++;
      else if (k !== studyDayKey(now)) break; // hoje ainda sem revisão não quebra a sequência
      if (streak > 3650) break;
    }

    const last30 = recent.filter((r) => new Date(r.reviewed_at) >= new Date(dayStart.getTime() - 29 * DAY_MS));
    const matured = last30.filter((r) => r.state_before === State.Review);
    const retention = matured.length ? matured.filter((r) => r.rating > 1).length / matured.length : null;
    const predicted = matured.length ? matured.reduce((a, r) => a + (r.retrievability ?? 0), 0) / matured.length : null;

    const calibration = [1, 2, 3, 4].map((c) => {
      const rows = recent.filter((r) => r.confidence === c);
      return { confidence: c, n: rows.length, success: rows.length ? rows.filter((r) => r.rating > 1).length / rows.length : null };
    });

    const durations = recent.map((r) => r.duration_ms).filter((d) => d > 0).slice(-200);
    const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 45_000;

    const alerts = db.prepare(`SELECT r.id, r.note_id, r.confidence, r.reviewed_at, n.title, c.prompt, c.kind
      FROM reviews r JOIN notes n ON n.id = r.note_id LEFT JOIN cards c ON c.id = r.card_id
      WHERE r.confidence >= 3 AND r.rating = 1 AND r.alert_resolved = 0 AND r.reviewed_at >= ?
      ORDER BY r.reviewed_at DESC LIMIT 20`).all(new Date(now.getTime() - 21 * DAY_MS).toISOString());

    const totals = db.prepare(`SELECT COUNT(*) AS cards, SUM(state = 0) AS fresh, SUM(state = 2 AND stability >= 21) AS mature,
      AVG(CASE WHEN state != 0 THEN difficulty END) AS difficulty FROM cards WHERE suspended = 0`).get();

    return {
      today: { ...q.counts, total: dueTotal, done: heat[studyDayKey(now)] || 0, estimatedMinutes: Math.ceil(dueTotal * avgMs / 60_000) },
      streak, retention, predictedRetention: predicted, desiredRetention: settings.desiredRetention,
      reviews30: last30.length, forecast, heatmap: heat, calibration, alerts, totals,
      para: tree().map(({ key, label, total }) => ({ key, label, total })),
      recentNotes: listNotes({ limit: 6 })
    };
  }

  function resolveAlert(reviewId) {
    db.prepare('UPDATE reviews SET alert_resolved = 1 WHERE id = ?').run(Number(reviewId));
    return { ok: true };
  }

  // ---------- backup ----------
  function exportAll() {
    const notes = db.prepare('SELECT * FROM notes').all().map((n) => ({ ...n, body: readBody(n) }));
    return {
      app: 'MemoPARA', version: 1, exportedAt: clock().toISOString(),
      settings: getSettings(), notes,
      cards: db.prepare('SELECT * FROM cards').all(),
      reviews: db.prepare('SELECT * FROM reviews').all()
    };
  }

  function importAll(data) {
    if (data?.app !== 'MemoPARA' || !Array.isArray(data.notes)) throw httpError(400, 'Arquivo de backup inválido.');
    transaction(db, () => {
      db.exec('DELETE FROM reviews; DELETE FROM cards; DELETE FROM notes; DELETE FROM notes_fts;');
      const insNote = db.prepare(`INSERT INTO notes (id, path, title, para, folder, loci, archived, missing, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
      for (const n of data.notes) {
        assertPara(n.para);
        const rel = resolveInside(vaultDir, n.path) && n.path;
        writeNoteFile(resolveInside(vaultDir, rel), n.id, n.body ?? '', []);
        insNote.run(n.id, rel, n.title, n.para, sanitizeFolder(n.folder), n.loci ?? '', n.para === 'archives' ? 1 : 0,
          hash(n.body ?? ''), n.created_at, n.updated_at);
        indexNote(n.id, n.title, n.body ?? '');
      }
      const insCard = db.prepare(`INSERT INTO cards (id, note_id, key, kind, prompt, answer, ord, state, stability, difficulty, due,
        last_review, reps, lapses, suspended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of data.cards || []) insCard.run(c.id, c.note_id, c.key, c.kind, c.prompt, c.answer, c.ord, c.state, c.stability,
        c.difficulty, c.due, c.last_review, c.reps, c.lapses, c.suspended);
      const insRev = db.prepare(`INSERT INTO reviews (id, card_id, note_id, rating, confidence, recall_text, state_before, elapsed_days,
        retrievability, stability_after, difficulty_after, interval_days, duration_ms, alert_resolved, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of data.reviews || []) insRev.run(r.id, r.card_id, r.note_id, r.rating, r.confidence, r.recall_text, r.state_before,
        r.elapsed_days, r.retrievability, r.stability_after, r.difficulty_after, r.interval_days, r.duration_ms, r.alert_resolved, r.reviewed_at);
    });
    if (data.settings) updateSettings(data.settings);
    return { ok: true, notes: data.notes.length };
  }

  return {
    vaultDir, getSettings, updateSettings, createNote, updateNote, deleteNote, getNote, listNotes, tree, createFolder,
    syncVault, queue, cardForReview, reviewCard, resetCard, setCardSuspended, dashboard, resolveAlert, exportAll, importAll,
    notePathOf: (id) => resolveInside(vaultDir, getNoteRow(id).path),
    sanitizeSegment
  };
}
