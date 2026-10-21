import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    para TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    loci TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    ord INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 0,
    stability REAL NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    last_review TEXT,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_id, key)
  );
  CREATE INDEX cards_due ON cards(due) WHERE suspended = 0;
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    note_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    confidence INTEGER,
    recall_text TEXT,
    state_before INTEGER NOT NULL,
    elapsed_days REAL,
    retrievability REAL,
    stability_after REAL,
    difficulty_after REAL,
    interval_days INTEGER,
    duration_ms INTEGER,
    alert_resolved INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT NOT NULL
  );
  CREATE INDEX reviews_at ON reviews(reviewed_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
  `,
  `
  CREATE TABLE apostilas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    para TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    note_id TEXT,
    pdf_path TEXT,
    link_target TEXT,
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE apostila_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apostila_id TEXT NOT NULL REFERENCES apostilas(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    original TEXT NOT NULL,
    ord INTEGER NOT NULL,
    rotation INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    ocr_text TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX apostila_pages_order ON apostila_pages(apostila_id, ord);
  `
];

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
