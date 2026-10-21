import { api, h, $, icon, toast, fmtInterval, pct, STATE_LABEL } from '../ui.js';
import { esc, renderMarkdown } from '../md.js';
import { app, refreshDueCount } from '../main.js';

const RATINGS = [
  { g: 1, label: 'Esqueci' },
  { g: 2, label: 'Difícil' },
  { g: 3, label: 'Bom' },
  { g: 4, label: 'Fácil' }
];
const CONF = ['Chutando', 'Inseguro', 'Confiante', 'Certeza'];

export async function renderReview(view, { noteId } = {}) {
  const url = noteId ? `/api/queue?note=${encodeURIComponent(noteId)}` : '/api/queue?limit=200';
  let queue = (await api(url)).cards;
  if (!view.isConnected) return;
  const session = { done: 0, correct: 0, startedAt: Date.now(), total: queue.length, again: 0 };
  let current = null;
  let revealed = false;
  let confidence = null;
  let shownAt = 0;
  let busy = false;

  const root = h('<div class="review"></div>');
  view.append(root);

  const onKey = (e) => {
    if (!current || busy || e.ctrlKey && e.key !== 'Enter' || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const inText = document.activeElement?.tagName === 'TEXTAREA';
    if (!revealed) {
      if (e.key === 'Enter' && (e.ctrlKey || !inText)) { e.preventDefault(); reveal(); }
      else if (e.key === ' ' && !inText) { e.preventDefault(); reveal(); }
      else if (!inText && /^[1-4]$/.test(e.key)) setConfidence(Number(e.key));
    } else if (/^[1-4]$/.test(e.key)) { e.preventDefault(); rate(Number(e.key)); }
    else if (e.key === ' ') { e.preventDefault(); rate(3); }
  };
  document.addEventListener('keydown', onKey);
  app.cleanup = () => document.removeEventListener('keydown', onKey);

  next();

  async function next() {
    if (!queue.length && !noteId && session.done) {
      // cartões que você errou voltam no mesmo dia (etapa de reaprendizagem)
      queue = (await api('/api/queue?limit=200')).cards;
      session.total = session.done + queue.length;
    }
    current = queue.shift() || null;
    revealed = false;
    confidence = null;
    if (!current) return finish();
    shownAt = Date.now();
    paint();
  }

  function paint() {
    const c = current;
    const progress = session.total ? Math.round((session.done / session.total) * 100) : 0;
    const prompt = c.kind === 'note' ? c.note_title : c.prompt;
    root.replaceChildren(h(`<div>
      <div class="review-top">
        <a class="btn ghost sm" href="#/">Sair</a>
        <div class="progress" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${progress}%"></i></div>
        <span class="muted" style="font-size:13px">${session.done} / ${session.total}</span>
      </div>
    </div>`));
    root.append(h(`<article class="card flash">
      <div class="crumb">
        <span class="chip">${esc(app.meta.para[c.para].label)}${c.folder ? ' / ' + esc(c.folder) : ''}</span>
        ${c.kind === 'qa' ? `<span>de <a href="#/nota/${c.note_id}">${esc(c.note_title)}</a></span>` : '<span>Nota inteira</span>'}
        <span class="spacer"></span>
        <span class="badge ${c.state === 0 ? 'new' : ''}">${STATE_LABEL[c.state]}</span>
        ${c.retrievability != null ? `<span class="badge" title="Chance estimada de lembrar agora (FSRS)">R ${pct(c.retrievability)}</span>` : ''}
      </div>
      <div class="prompt">${c.kind === 'qa' ? renderInline(prompt) : esc(prompt)}</div>
      ${c.loci ? `<div class="loci">${icon('pin', 16)}<span><strong>Palácio da memória:</strong> ${esc(c.loci)}</span></div>` : ''}
      <div class="recall">
        <div class="step-label">1 · Recorde antes de ver</div>
        <textarea rows="${c.kind === 'note' ? 5 : 2}" placeholder="${c.kind === 'note' ? 'Escreva os pontos principais que você lembra (opcional, mas é o que mais fortalece a memória)…' : 'Sua resposta (opcional)…'}"></textarea>
      </div>
      <div>
        <div class="step-label" style="margin-bottom:8px">2 · Quão seguro você está?</div>
        <div class="confidence">${CONF.map((l, i) => `<button type="button" data-c="${i + 1}" aria-pressed="false">${l} <kbd>${i + 1}</kbd></button>`).join('')}</div>
      </div>
      <div class="row end"><button class="btn primary lg" data-reveal>Mostrar resposta <kbd>Espaço</kbd></button></div>
    </article>`));
    root.append(h(`<p class="review-hint">Atalhos: <kbd>1</kbd>–<kbd>4</kbd> confiança · <kbd>Espaço</kbd> mostrar · depois <kbd>1</kbd>–<kbd>4</kbd> para avaliar · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> dentro do texto</p>`));
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => setConfidence(Number(b.dataset.c))));
    $('[data-reveal]', root).addEventListener('click', reveal);
    $('textarea', root).focus();
  }

  function setConfidence(v) {
    confidence = confidence === v ? null : v;
    root.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.c) === confidence)));
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    const c = current;
    const recall = $('textarea', root).value.trim();
    current.recallText = recall;
    const flash = $('.flash', root);
    $('.recall', flash).replaceWith(h(recall ? `<div class="recall"><div class="step-label" style="margin-bottom:6px">Sua recordação</div><div class="help" style="white-space:pre-wrap">${esc(recall)}</div></div>` : '<div></div>'));
    $('.confidence', flash).parentElement.remove();
    $('[data-reveal]', flash).parentElement.remove();
    flash.append(h(`<div class="answer">
      <div class="step-label" style="margin-bottom:10px">Resposta${recall ? ' — compare com o que você escreveu' : ''}</div>
      <div class="md">${c.kind === 'note' ? (c.body?.trim() ? renderMarkdown(c.body, { base: dirOf(c.path) }) : '<p class="muted">Nota vazia.</p>') : renderMarkdown(c.answer, { cards: false, base: dirOf(c.path) })}</div>
    </div>`));
    flash.append(h(`<div>
      <div class="step-label" style="margin-bottom:8px">3 · Como foi?${confidence ? ` <span class="muted" style="text-transform:none;letter-spacing:0">(você marcou “${CONF[confidence - 1]}”)</span>` : ''}</div>
      <div class="ratings">${RATINGS.map((r) => `<button type="button" data-g="${r.g}"><b>${r.label}</b><small>${fmtInterval(c.preview[r.g].intervalDays)}</small><kbd>${r.g}</kbd></button>`).join('')}</div>
    </div>`));
    flash.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => rate(Number(b.dataset.g))));
    $('.review-hint', root).innerHTML = '<kbd>1</kbd> Esqueci · <kbd>2</kbd> Difícil · <kbd>3</kbd>/<kbd>Espaço</kbd> Bom · <kbd>4</kbd> Fácil — o intervalo abaixo de cada botão é calculado pelo FSRS';
    document.activeElement?.blur();
  }

  async function rate(g) {
    if (!revealed || busy) return;
    busy = true;
    try {
      const res = await api(`/api/cards/${current.id}/review`, {
        method: 'POST',
        body: { rating: g, confidence, recallText: current.recallText || null, durationMs: Date.now() - shownAt }
      });
      session.done++;
      if (g > 1) session.correct++; else session.again++;
      if (res.overconfident) toast('Ilusão de competência: você tinha certeza e esqueceu. Esse cartão vai aparecer no painel.', 'error', 5000);
      if (noteId && g === 1) queue.push(await api(`/api/cards/${current.id}`));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
    next();
  }

  function finish() {
    const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    refreshDueCount();
    root.replaceChildren(h(`<div class="card empty">
      <h2>${session.done ? 'Sessão concluída!' : 'Nada para revisar agora'}</h2>
      <p>${session.done
        ? `${session.done} ${session.done === 1 ? 'revisão' : 'revisões'} em ~${minutes} min · ${pct(session.correct / session.done)} lembrados. O FSRS já agendou cada cartão para o momento em que você estaria perto de esquecê-lo.`
        : 'Todos os cartões estão em dia. Volte amanhã — ou crie novas notas.'}</p>
      <div class="row"><a class="btn primary" href="#/">Ir para o painel</a><a class="btn" href="#/nova">Nova nota</a></div>
    </div>`));
  }
}

function renderInline(text) {
  return renderMarkdown(text, { cards: false }).replace(/^<p>|<\/p>$/g, '');
}

const dirOf = (p) => (p ? p.split('/').slice(0, -1).join('/') : null);
