import { api, h, $, icon, toast, confirmDialog, relDays, pct, fmtInterval, STATE_LABEL } from '../ui.js';
import { esc, renderMarkdown } from '../md.js';
import { app, refreshDueCount } from '../main.js';

const TEMPLATE = `# Título

Resumo com suas palavras: o que é, por que importa, como se conecta ao que você já sabe.

## Pontos-chave
-

## Flashcards
Pergunta de exemplo :: Resposta de exemplo
`;

export async function renderEditor(view, { id, draft }) {
  let note = id ? await api(`/api/notes/${encodeURIComponent(id)}`) : null;
  const tree = await api('/api/tree');
  if (!view.isConnected) return; // o usuário já mudou de tela
  const state = {
    title: note?.title ?? '',
    para: note?.para ?? (app.meta.para[draft?.para] ? draft.para : 'inbox'),
    folder: note?.folder ?? draft?.folder ?? '',
    loci: note?.loci ?? '',
    body: note?.body ?? TEMPLATE
  };
  let mode = 'split';
  try { mode = localStorage.getItem('memopara-editor-mode') || 'split'; } catch { /* sem storage */ }
  let dirty = false;
  let saving = null;
  let timer = null;

  view.append(h(`<div class="page">
    <div class="editor-head">
      <a class="btn ghost sm" href="${note ? `#/notas?para=${note.para}${note.folder ? `&folder=${encodeURIComponent(note.folder)}` : ''}` : '#/notas'}">← Notas</a>
      <input class="title-input" name="title" placeholder="Título da nota" value="${esc(state.title)}" aria-label="Título" maxlength="200">
      <span class="muted" data-status style="font-size:13px">${note ? 'Salvo' : 'Nova nota'}</span>
      <button class="btn primary" data-save>${note ? 'Salvar' : 'Criar nota'} <kbd>Ctrl S</kbd></button>
    </div>
    <div class="fields">
      <label>Categoria PARA
        <select name="para">${Object.entries(app.meta.para).map(([k, v]) => `<option value="${k}" ${k === state.para ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      </label>
      <label>Pasta (use / para subpastas)
        <input name="folder" list="folder-list" value="${esc(state.folder)}" placeholder="ex.: Biologia/Genética" autocomplete="off">
        <datalist id="folder-list"></datalist>
      </label>
      <label>Palácio da memória (loci) — opcional
        <input name="loci" value="${esc(state.loci)}" placeholder="ex.: a geladeira da cozinha" maxlength="300">
      </label>
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label="Modo do editor">
        ${[['edit', 'Editar'], ['split', 'Dividir'], ['view', 'Visualizar']].map(([k, l]) => `<button data-mode="${k}" aria-pressed="${k === mode}">${l}</button>`).join('')}
      </div>
      <span class="help" style="padding:6px 12px">Uma linha <code>pergunta :: resposta</code> vira flashcard. A nota inteira também é revisada.</span>
    </div>
    <div class="editor-panes">
      <textarea name="body" spellcheck="true" aria-label="Conteúdo em Markdown">${esc(state.body)}</textarea>
      <div class="card preview md"></div>
    </div>
    <div data-extra></div>
  </div>`));

  const $f = (n) => $(`[name=${n}]`, view);
  const textarea = $f('body');
  const preview = $('.preview', view);
  const status = $('[data-status]', view);

  const fillFolders = () => {
    const sec = tree.find((s) => s.key === $f('para').value);
    $('#folder-list', view).innerHTML = (sec?.folders || []).map((f) => `<option value="${esc(f.path)}">`).join('');
  };
  const applyMode = () => {
    const panes = $('.editor-panes', view);
    panes.classList.toggle('single', mode !== 'split');
    textarea.hidden = mode === 'view';
    preview.hidden = mode === 'edit';
    view.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  };
  const paintPreview = () => { preview.innerHTML = renderMarkdown(textarea.value) || '<p class="muted">Pré-visualização</p>'; };
  fillFolders();
  applyMode();
  paintPreview();
  paintExtra();

  view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    try { localStorage.setItem('memopara-editor-mode', mode); } catch { /* ignore */ }
    applyMode();
  }));
  $f('para').addEventListener('change', fillFolders);
  view.addEventListener('input', (e) => {
    if (!e.target.name) return;
    if (e.target === textarea) paintPreview();
    dirty = true;
    status.textContent = 'Alterações não salvas';
    // notas existentes salvam sozinhas após uma pausa na digitação
    if (note) { clearTimeout(timer); timer = setTimeout(save, 1500); }
  });
  view.addEventListener('change', (e) => { if (note && ['para', 'folder'].includes(e.target.name)) { clearTimeout(timer); save(); } });
  $('[data-save]', view).addEventListener('click', save);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  const onUnload = (e) => { if (dirty) e.preventDefault(); };
  document.addEventListener('keydown', onKey);
  addEventListener('beforeunload', onUnload);
  app.cleanup = () => {
    document.removeEventListener('keydown', onKey);
    removeEventListener('beforeunload', onUnload);
    clearTimeout(timer);
    if (dirty && note) save();
  };
  if (!note) { $f('title').focus(); }

  async function save() {
    if (saving) return saving;
    const payload = { title: $f('title').value, para: $f('para').value, folder: $f('folder').value, loci: $f('loci').value, body: textarea.value };
    if (!payload.title.trim()) { toast('Dê um título à nota.', 'error'); $f('title').focus(); return; }
    status.textContent = 'Salvando…';
    saving = (async () => {
      try {
        const saved = note
          ? await api(`/api/notes/${note.id}`, { method: 'PUT', body: payload })
          : await api('/api/notes', { method: 'POST', body: payload });
        const created = !note;
        note = saved;
        dirty = false;
        status.textContent = `Salvo · ${note.path}`;
        if (created) {
          toast('Nota criada. A primeira revisão fica para o próximo dia de estudo.', 'good');
          history.replaceState(null, '', `#/nota/${note.id}`);
          $('[data-save]', view).innerHTML = 'Salvar <kbd>Ctrl S</kbd>';
        }
        if ($f('folder').value !== note.folder) $f('folder').value = note.folder;
        paintExtra();
        refreshDueCount();
      } catch (err) {
        status.textContent = 'Erro ao salvar';
        toast(err.message, 'error');
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  function paintExtra() {
    const extra = $('[data-extra]', view);
    if (!note) { extra.replaceChildren(); return; }
    const archived = note.para === 'archives';
    extra.replaceChildren(h(`<div class="grid main-side">
      <div class="card">
        <div class="card-head"><h2>Cartões desta nota</h2><small>agendados pelo FSRS</small></div>
        <div style="overflow-x:auto"><table class="cards-table">
          <thead><tr><th>Cartão</th><th>Estado</th><th title="Dias até a chance de lembrar cair para 90%">Estabilidade</th><th title="Chance de lembrar agora">Lembrança</th><th>Próxima</th><th></th></tr></thead>
          <tbody>${note.cards.map((c) => `<tr>
            <td>${c.kind === 'note' ? '<strong>Nota inteira</strong>' : `${esc(c.prompt)}<br><small>${esc(c.answer)}</small>`}</td>
            <td>${c.suspended ? '<span class="badge">suspenso</span>' : STATE_LABEL[c.state]}${c.lapses ? `<br><small>${c.lapses} lapsos</small>` : ''}</td>
            <td>${c.state ? fmtInterval(Math.max(1, Math.round(c.stability))) : '—'}</td>
            <td>${c.retrievability != null ? pct(c.retrievability) : '—'}</td>
            <td>${c.suspended ? '—' : relDays(c.due)}</td>
            <td><button class="btn sm ghost" data-suspend="${c.id}" data-on="${c.suspended ? 0 : 1}">${c.suspended ? 'Reativar' : 'Suspender'}</button>
              ${c.reps ? `<button class="btn sm ghost" data-reset="${c.id}">Reiniciar</button>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <h2>Ações</h2>
        <a class="btn primary" href="#/revisar/${note.id}">${icon('review', 16)} Revisar esta nota agora</a>
        <button class="btn" data-reveal-file>${icon('folder', 16)} Mostrar arquivo no Explorer</button>
        <button class="btn" data-archive>${archived ? 'Desarquivar (volta para Recursos)' : 'Arquivar'}</button>
        <button class="btn danger" data-delete>Excluir (vai para a lixeira do vault)</button>
        ${note.history.length ? `<h3 style="margin-top:8px">Histórico da nota</h3><div class="list">${note.history.map((r) => `<div class="list-item" style="padding:6px 2px">
          <span class="grow"><small>${new Date(r.reviewed_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })}</small></span>
          <span class="badge ${['', 'bad', 'warn', 'ok', 'new'][r.rating]}">${['', 'Esqueci', 'Difícil', 'Bom', 'Fácil'][r.rating]}</span></div>`).join('')}</div>` : ''}
        <small>Arquivo: <span class="path">${esc(note.path)}</span></small>
      </div>
    </div>`));

    extra.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/cards/${b.dataset.suspend}/suspend`, { method: 'POST', body: { suspended: b.dataset.on === '1' } });
      note = await api(`/api/notes/${note.id}`); paintExtra();
    }));
    extra.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Reiniciar este cartão? O histórico de agendamento dele volta ao zero.', { ok: 'Reiniciar' }))) return;
      await api(`/api/cards/${b.dataset.reset}/reset`, { method: 'POST', body: {} });
      note = await api(`/api/notes/${note.id}`); paintExtra();
    }));
    $('[data-reveal-file]', extra).addEventListener('click', () => api(`/api/notes/${note.id}/reveal`, { method: 'POST', body: {} }));
    $('[data-archive]', extra).addEventListener('click', async () => {
      await save();
      note = await api(`/api/notes/${note.id}`, { method: 'PUT', body: { para: archived ? 'resources' : 'archives' } });
      $f('para').value = note.para;
      fillFolders();
      toast(archived ? 'Nota desarquivada.' : 'Nota arquivada — os cartões ficam pausados.', 'good');
      paintExtra();
    });
    $('[data-delete]', extra).addEventListener('click', async () => {
      if (!(await confirmDialog(`Excluir “${note.title}”? O arquivo vai para a pasta .trash do vault.`, { ok: 'Excluir', danger: true }))) return;
      await api(`/api/notes/${note.id}`, { method: 'DELETE' });
      dirty = false;
      toast('Nota excluída.');
      location.hash = '#/notas';
    });
  }
}
