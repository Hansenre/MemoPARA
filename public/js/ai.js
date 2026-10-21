// IA local: pede sugestões ao servidor (LM Studio), mostra o progresso e a tela de revisão.
// O usuário escolhe o que entra na nota; nada é inserido sem passar por aqui.
import { api, h, $, $$, toast } from './ui.js';
import { esc, renderMarkdown } from './md.js';

const SUMMARY_PLACEHOLDER = /^Escreva com suas palavras.*$/;
const CARD_PLACEHOLDER = /^Pergunta :: Resposta\s*$/;

// ---------- inserção na nota (função pura, testada) ----------
function section(lines, title) {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\b`, 'i').test(l.trim()));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  return { start, end };
}

// subtítulos da IA ficam abaixo do "## Resumo"
const demote = (md) => md.replace(/^#{1,2}\s+/gm, '### ').trim();

export function insertSuggestions(body, { summary = '', cards = [] }) {
  let lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');

  if (summary.trim()) {
    const text = demote(summary).split('\n');
    const sec = section(lines, 'Resumo');
    if (sec) {
      const content = lines.slice(sec.start + 1, sec.end).filter((l) => l.trim() && !SUMMARY_PLACEHOLDER.test(l.trim()));
      const kept = lines.slice(sec.start + 1, sec.end).filter((l) => !SUMMARY_PLACEHOLDER.test(l.trim()));
      const block = content.length ? ['', ...trimBlank(kept), '', ...text, ''] : ['', ...text, ''];
      lines = [...lines.slice(0, sec.start + 1), ...block, ...lines.slice(sec.end)];
    } else {
      const firstSection = lines.findIndex((l) => /^##\s/.test(l));
      const block = ['## Resumo', '', ...text, ''];
      lines = firstSection === -1 ? [...trimBlank(lines), '', ...block] : [...lines.slice(0, firstSection), ...block, ...lines.slice(firstSection)];
    }
  }

  if (cards.length) {
    const cardLines = cards.map((c) => `${c.pergunta} :: ${c.resposta}`);
    const sec = section(lines, 'Flashcards');
    if (sec) {
      const kept = trimBlank(lines.slice(sec.start + 1, sec.end).filter((l) => !CARD_PLACEHOLDER.test(l.trim())));
      lines = [...lines.slice(0, sec.start + 1), '', ...kept, ...cardLines, '', ...lines.slice(sec.end)];
    } else {
      const content = section(lines, 'Conteúdo do PDF');
      const block = ['## Flashcards', '', ...cardLines, ''];
      lines = content ? [...lines.slice(0, content.start), ...block, ...lines.slice(content.start)] : [...trimBlank(lines), '', ...block];
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function trimBlank(arr) {
  let a = 0;
  let b = arr.length;
  while (a < b && !arr[a].trim()) a++;
  while (b > a && !arr[b - 1].trim()) b--;
  return arr.slice(a, b);
}

// ---------- fluxo completo: status -> tarefa -> revisão ----------
export async function suggestForNote(noteId) {
  const status = await api('/api/ai/status').catch(() => ({ reachable: false }));
  if (!status.reachable) {
    toast('O LM Studio não está respondendo. Abra o LM Studio e ligue o servidor local (porta 1234).', 'error', 7000);
    return null;
  }
  if (!status.available) {
    toast(`O modelo ${status.model} não está disponível no LM Studio. Modelos encontrados: ${status.models.join(', ') || 'nenhum'}.`, 'error', 8000);
    return null;
  }
  const job = await api('/api/ai/jobs', { method: 'POST', body: { noteId } });
  const result = await waitForJob(job.id, status.model);
  return result ? reviewDialog(result) : null;
}

function waitForJob(id, model) {
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="dialog ai-progress">
      <h2>✨ Gerando sugestões</h2>
      <p class="muted" style="margin:0">Modelo local <strong>${esc(model)}</strong> no LM Studio. Nada sai do seu computador.</p>
      <div class="progress"><i style="width:4%"></i></div>
      <div class="row"><small data-label class="muted">Preparando…</small><span class="spacer"></span><small data-time class="muted">0 s</small></div>
      <div class="row end"><button class="btn ghost" data-cancel>Cancelar</button></div>
    </dialog>`);
    document.body.append(dlg);
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearInterval(timer); dlg.close(); dlg.remove(); resolve(value); };
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    $('[data-cancel]', dlg).addEventListener('click', () => { api(`/api/ai/jobs/${id}`, { method: 'DELETE' }).catch(() => {}); finish(null); });
    const timer = setInterval(async () => {
      try {
        const j = await api(`/api/ai/jobs/${id}`);
        $('[data-time]', dlg).textContent = `${j.elapsed} s`;
        $('[data-label]', dlg).textContent = j.progress?.label || '';
        const ratio = j.progress?.total ? (j.progress.step - (j.status === 'running' ? 0.5 : 0)) / j.progress.total : 0;
        $('.progress i', dlg).style.width = `${Math.max(4, Math.round(ratio * 100))}%`;
        if (j.status === 'done') finish(j.result);
        else if (j.status === 'error') { toast(j.error, 'error', 8000); finish(null); }
        else if (j.status === 'cancelled') finish(null);
      } catch (err) { toast(err.message, 'error'); finish(null); }
    }, 1000);
    dlg.showModal();
  });
}

function reviewDialog(r) {
  return new Promise((resolve) => {
    const summaryText = [r.resumo, r.pontos_chave.length ? `**Pontos-chave**\n${r.pontos_chave.map((p) => `- ${p}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const dlg = h(`<dialog class="ai-review">
      <header>
        <div><h2>✨ Sugestões da IA local</h2>
          <small class="muted">${esc(r.model)} · ${r.seconds.toLocaleString('pt-BR')} s · ${r.mode === 'uma passagem' ? 'texto lido de uma vez' : `lido página a página (${r.parts} partes)`}</small></div>
        <span class="spacer"></span>
        <span class="badge warn">revise antes de inserir</span>
      </header>
      <div class="ai-body">
        ${r.avisos.length ? `<div class="ai-warn"><strong>Confira no material original</strong><ul>${r.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
        <section>
          <label class="check"><input type="checkbox" data-use-summary ${summaryText.trim() ? 'checked' : ''}> <strong>Inserir o resumo</strong> <small class="muted">(vai para a seção “Resumo”; edite à vontade)</small></label>
          <div class="seg" role="group" style="margin:8px 0"><button type="button" data-sview="edit" aria-pressed="true">Editar</button><button type="button" data-sview="view" aria-pressed="false">Visualizar</button></div>
          <textarea data-summary rows="10" spellcheck="true">${esc(summaryText)}</textarea>
          <div class="md card" data-summary-view hidden></div>
        </section>
        <section>
          <div class="row"><strong>Flashcards (${r.flashcards.length})</strong><span class="spacer"></span>
            <button type="button" class="btn sm ghost" data-all>Marcar todos</button><button type="button" class="btn sm ghost" data-none>Nenhum</button></div>
          ${r.flashcards.length ? `<div class="ai-cards">${r.flashcards.map((c, i) => `
            <div class="ai-card${c.foraDoTexto ? ' ungrounded' : ''}" data-i="${i}">
              <input type="checkbox" ${c.foraDoTexto ? '' : 'checked'} aria-label="Usar este cartão">
              <div class="ai-card-fields">
                <input data-q value="${esc(c.pergunta)}" aria-label="Pergunta">
                <input data-a value="${esc(c.resposta)}" aria-label="Resposta">
                ${c.foraDoTexto ? '<small class="ai-check">⚠ não encontrado no texto — o modelo pode ter inventado</small>' : ''}
                ${c.conferir.length ? `<small class="ai-check">⚠ confira: ${esc(c.conferir.join(', '))} (não aparece igual no texto)</small>` : ''}
              </div>
            </div>`).join('')}</div>` : '<p class="muted">Nenhum cartão novo sugerido (os que já existem na nota foram ignorados).</p>'}
        </section>
      </div>
      <footer class="row end">
        <button type="button" class="btn ghost" data-cancel>Descartar</button>
        <button type="button" class="btn primary" data-insert></button>
      </footer>
    </dialog>`);
    document.body.append(dlg);
    const paintButton = () => {
      const n = $$('.ai-card input[type=checkbox]:checked', dlg).length;
      const s = $('[data-use-summary]', dlg).checked && !!$('[data-summary]', dlg).value.trim();
      const btn = $('[data-insert]', dlg);
      btn.textContent = s && n ? `Inserir resumo e ${n} ${n === 1 ? 'cartão' : 'cartões'}` : s ? 'Inserir resumo' : n ? `Inserir ${n} ${n === 1 ? 'cartão' : 'cartões'}` : 'Nada selecionado';
      btn.disabled = !s && !n;
    };
    paintButton();
    dlg.addEventListener('change', paintButton);
    $('[data-summary]', dlg).addEventListener('input', paintButton);
    $('[data-all]', dlg).addEventListener('click', () => { $$('.ai-card input[type=checkbox]', dlg).forEach((c) => { c.checked = true; }); paintButton(); });
    $('[data-none]', dlg).addEventListener('click', () => { $$('.ai-card input[type=checkbox]', dlg).forEach((c) => { c.checked = false; }); paintButton(); });
    $$('[data-sview]', dlg).forEach((b) => b.addEventListener('click', () => {
      const view = b.dataset.sview === 'view';
      $$('[data-sview]', dlg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('[data-summary]', dlg).hidden = view;
      const box = $('[data-summary-view]', dlg);
      box.hidden = !view;
      if (view) box.innerHTML = renderMarkdown($('[data-summary]', dlg).value);
    }));
    let chosen = null;
    $('[data-cancel]', dlg).addEventListener('click', () => dlg.close());
    $('[data-insert]', dlg).addEventListener('click', () => {
      chosen = {
        summary: $('[data-use-summary]', dlg).checked ? $('[data-summary]', dlg).value : '',
        cards: $$('.ai-card', dlg)
          .filter((el) => $('input[type=checkbox]', el).checked)
          .map((el) => ({ pergunta: $('[data-q]', el).value.replace(/\s*::\s*/g, ': ').trim(), resposta: $('[data-a]', el).value.replace(/\s*::\s*/g, ': ').trim() }))
          .filter((c) => c.pergunta && c.resposta)
      };
      dlg.close();
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(chosen); });
    dlg.showModal();
  });
}
