// FSRS-5 (Free Spaced Repetition Scheduler) — o algoritmo usado pelo Anki moderno.
// Cada cartão tem Estabilidade (S, em dias: tempo até a chance de lembrar cair a 90%)
// e Dificuldade (D, 1..10). A cada revisão, S e D são atualizadas conforme a nota dada
// e a "recuperabilidade" R (probabilidade de lembrar naquele momento).

export const DEFAULT_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621
];

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };

const DECAY = -0.5;
const FACTOR = 19 / 81; // garante R = 0.9 quando t = S
const DAY_MS = 86_400_000;
const RELEARN_MINUTES = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function retrievability(elapsedDays, stability) {
  if (!(stability > 0)) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
}

export class FSRS {
  constructor({ weights = DEFAULT_WEIGHTS, desiredRetention = 0.9, maxInterval = 36500, fuzz = true, random = Math.random } = {}) {
    this.w = weights;
    this.desiredRetention = clamp(desiredRetention, 0.7, 0.99);
    this.maxInterval = maxInterval;
    this.fuzz = fuzz;
    this.random = random;
  }

  initStability(g) { return Math.max(this.w[g - 1], 0.1); }

  initDifficulty(g) { return clamp(this.w[4] - Math.exp(this.w[5] * (g - 1)) + 1, 1, 10); }

  nextDifficulty(d, g) {
    const delta = -this.w[6] * (g - 3);
    const damped = d + delta * (10 - d) / 9;
    // reversão à média, puxando para a dificuldade de um cartão "Fácil"
    return clamp(this.w[7] * this.initDifficulty(Rating.Easy) + (1 - this.w[7]) * damped, 1, 10);
  }

  recallStability(d, s, r, g) {
    const hardPenalty = g === Rating.Hard ? this.w[15] : 1;
    const easyBonus = g === Rating.Easy ? this.w[16] : 1;
    return s * (1 + Math.exp(this.w[8]) * (11 - d) * Math.pow(s, -this.w[9]) *
      (Math.exp(this.w[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
  }

  forgetStability(d, s, r) {
    const sf = this.w[11] * Math.pow(d, -this.w[12]) * (Math.pow(s + 1, this.w[13]) - 1) * Math.exp(this.w[14] * (1 - r));
    return Math.min(sf, s);
  }

  shortTermStability(s, g) {
    return s * Math.exp(this.w[17] * (g - 3 + this.w[18]));
  }

  intervalFor(s) {
    const ivl = s / FACTOR * (Math.pow(this.desiredRetention, 1 / DECAY) - 1);
    return clamp(Math.round(ivl), 1, this.maxInterval);
  }

  applyFuzz(ivl) {
    if (!this.fuzz || ivl < 3) return ivl;
    const delta = Math.max(1, Math.round(ivl * 0.05));
    return clamp(ivl - delta + Math.floor(this.random() * (2 * delta + 1)), 2, this.maxInterval);
  }

  // Calcula o resultado das 4 notas possíveis sem alterar o cartão.
  preview(card, now = new Date()) {
    const out = {};
    for (const g of [1, 2, 3, 4]) out[g] = this.#step(card, g, now, false);
    // garante a ordem Difícil <= Bom < Fácil em dias
    if (out[2].intervalDays && out[3].intervalDays) {
      out[2].intervalDays = Math.min(out[2].intervalDays, out[3].intervalDays);
      out[3].intervalDays = Math.max(out[3].intervalDays, out[2].intervalDays + 1);
      out[4].intervalDays = Math.max(out[4].intervalDays, out[3].intervalDays + 1);
      for (const g of [2, 3, 4]) out[g].due = addDays(now, out[g].intervalDays).toISOString();
    }
    return out;
  }

  // Aplica uma nota e devolve o novo estado do cartão (com fuzz no intervalo).
  review(card, g, now = new Date()) {
    if (![1, 2, 3, 4].includes(g)) throw new Error('Nota inválida (use 1 a 4).');
    const ordered = this.preview(card, now)[g];
    if (!ordered.intervalDays) return ordered;
    const intervalDays = this.applyFuzz(ordered.intervalDays);
    return { ...ordered, intervalDays, due: addDays(now, intervalDays).toISOString() };
  }

  #step(card, g, now) {
    const state = card.state ?? State.New;
    let s, d, r = null;
    const elapsedDays = card.last_review ? (now - new Date(card.last_review)) / DAY_MS : 0;

    if (state === State.New || !(card.stability > 0)) {
      s = this.initStability(g);
      d = this.initDifficulty(g);
    } else {
      r = retrievability(elapsedDays, card.stability);
      d = this.nextDifficulty(card.difficulty, g);
      if (elapsedDays < 1) s = this.shortTermStability(card.stability, g);
      else if (g === Rating.Again) s = this.forgetStability(card.difficulty, card.stability, r);
      else s = this.recallStability(card.difficulty, card.stability, r, g);
    }
    s = clamp(s, 0.1, 36500);

    if (g === Rating.Again) {
      const nextState = state === State.New || state === State.Learning ? State.Learning : State.Relearning;
      return {
        state: nextState, stability: s, difficulty: d, retrievability: r, elapsedDays,
        intervalDays: 0, due: new Date(now.getTime() + RELEARN_MINUTES * 60_000).toISOString()
      };
    }
    const intervalDays = this.intervalFor(s);
    return {
      state: State.Review, stability: s, difficulty: d, retrievability: r, elapsedDays,
      intervalDays, due: addDays(now, intervalDays).toISOString()
    };
  }
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}
