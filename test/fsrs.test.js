import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FSRS, State, retrievability } from '../src/fsrs.js';

const DAY = 86_400_000;
const t0 = new Date('2026-01-01T10:00:00Z');
const fsrs = new FSRS({ fuzz: false });
const newCard = { state: State.New, stability: 0, difficulty: 0, last_review: null };

test('retrievability is 90% when elapsed equals stability', () => {
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9);
  assert.equal(retrievability(0, 5), 1);
});

test('new card intervals follow default weights', () => {
  const p = fsrs.preview(newCard, t0);
  assert.equal(p[1].intervalDays, 0);
  assert.equal(p[1].state, State.Learning);
  assert.deepEqual([p[2].intervalDays, p[3].intervalDays, p[4].intervalDays], [1, 3, 16]);
});

test('successful reviews grow stability, lapses shrink it', () => {
  let card = { ...newCard, ...fsrs.review(newCard, 3, t0), last_review: t0.toISOString() };
  const t1 = new Date(t0.getTime() + card.intervalDays * DAY);
  const good = fsrs.review(card, 3, t1);
  const again = fsrs.review(card, 1, t1);
  assert.ok(good.stability > card.stability);
  assert.ok(good.intervalDays > card.intervalDays);
  assert.ok(again.stability < card.stability);
  assert.equal(again.state, State.Relearning);
  assert.ok(again.difficulty > card.difficulty);
});

test('preview keeps Hard <= Good < Easy', () => {
  const card = { state: State.Review, stability: 20, difficulty: 5, last_review: new Date(t0.getTime() - 20 * DAY).toISOString() };
  const p = fsrs.preview(card, t0);
  assert.ok(p[2].intervalDays <= p[3].intervalDays);
  assert.ok(p[3].intervalDays < p[4].intervalDays);
});

test('higher desired retention means shorter intervals', () => {
  const card = { state: State.Review, stability: 30, difficulty: 5, last_review: new Date(t0.getTime() - 30 * DAY).toISOString() };
  const strict = new FSRS({ desiredRetention: 0.95, fuzz: false }).preview(card, t0)[3].intervalDays;
  const loose = new FSRS({ desiredRetention: 0.8, fuzz: false }).preview(card, t0)[3].intervalDays;
  assert.ok(strict < loose);
});

test('fuzz stays within 5% band', () => {
  const f = new FSRS({ random: () => 0.999 });
  assert.equal(f.applyFuzz(100), 105);
  assert.equal(new FSRS({ random: () => 0 }).applyFuzz(100), 95);
  assert.equal(f.applyFuzz(2), 2);
});
