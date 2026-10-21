import { api, h, $, icon, toast, memoryBadge, relDays, promptDialog } from '../ui.js';
import { esc } from '../md.js';
import { app } from '../main.js';
import { importPdfFiles } from '../pdfimport.js';

export async function renderNotes(view, query) {
  const para = query.para || '';
  const folder = query.folder || '';
  const q = query.q || '';
  const [tree, notes] = await Promise.all([
    api('/api/tree'),
    api(`/api/notes?${new URLSearchParams({ ...(para && { para }), ...(folder && { folder }), ...(q && { q }) })}`)
  ]);
  const link = (p, f = '') => `#/notas?${new URLSearchParams({ ...(p && { para: p }), ...(f && { folder: f }) })}`;
  const where = para ? `${app.meta.para[para].label}${folder ? ' / ' + folder : ''}` : 'Todas as notas';

  view.append(h(`<div class="page">
    <div class="page-head">
      <div><h1>Notas</h1><p>Organizadas pelo método PARA: Projetos (com prazo), Áreas (contínuas), Recursos (referência) e Arquivo.</p></div>
      <div class="row">
        <button class="btn" data-sync title="Ler arquivos adicionados ou editados fora do app">${icon('sync', 16)} Sincronizar vault</button>
        <button class="btn" data-open-vault>${icon('folder', 16)} Abrir pasta</button>
      </div>
    </div>
    <div class="explorer">
      <nav class="card tree" aria-label="Pastas PARA">
        <div class="tree-sec"><a href="#/notas" class="${!para ? 'active' : ''}">${icon('notes', 16)}<span>Todas</span><small>${tree.reduce((a, s) => a + s.total, 0)}</small></a></div>
        ${tree.map((s) => `<div class="tree-sec">
          <a href="${link(s.key)}" class="${para === s.key && !folder ? 'active' : ''}">${icon('folder', 16)}<span>${esc(s.label)}</span><small>${s.total}</small></a>
          ${s.folders.map((f) => {
            const depth = f.path.split('/').length;
            return `<a class="tree-folder ${para === s.key && folder === f.path ? 'active' : ''}" style="padding-left:${14 + depth * 14}px" href="${link(s.key, f.path)}"><span>${esc(f.path.split('/').pop())}</span><small>${f.count || ''}</small></a>`;
          }).join('')}
        </div>`).join('')}
      </nav>
      <section class="card" style="display:flex;flex-direction:column;gap:14px">
        <div class="toolbar">
          <input type="search" placeholder="Buscar em ${esc(where.toLowerCase() === 'todas as notas' ? 'todas as notas' : where)}…" value="${esc(q)}" aria-label="Buscar">
          ${para ? `<button class="btn" data-new-folder>${icon('folder', 16)} Nova pasta</button>` : ''}
          <label class="btn" style="flex-direction:row;font-size:14px;color:var(--text)" title="O PDF vai para a pasta e vira uma nota editável com o texto dele">${icon('book', 16)} Importar PDF
            <input type="file" accept="application/pdf,.pdf" multiple hidden data-pdf></label>
          <a class="btn primary" href="#/nova?${new URLSearchParams({ para: para || 'inbox', ...(folder && { folder }) })}">${icon('plus', 16)} Nova nota</a>
        </div>
        <div class="row" style="justify-content:space-between"><h2>${esc(where)}</h2><small>${notes.length} ${notes.length === 1 ? 'nota' : 'notas'}</small></div>
        <div class="drop" data-drop>Arraste arquivos <code>.pdf</code>, <code>.md</code> ou <code>.txt</code> aqui para importar ${para ? `em <strong>${esc(where)}</strong>` : 'na Entrada'}</div>
        <div class="list">${notes.length ? notes.map(row).join('') : `<div class="empty"><p>${q ? 'Nenhuma nota encontrada.' : 'Esta pasta está vazia.'}</p></div>`}</div>
      </section>
    </div>
  </div>`));

  const search = $('input[type=search]', view);
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const params = new URLSearchParams({ ...(para && { para }), ...(folder && { folder }), ...(search.value.trim() && { q: search.value.trim() }) });
      history.replaceState(null, '', `#/notas?${params}`);
      api(`/api/notes?${params}`).then((list) => {
        $('.list', view).innerHTML = list.length ? list.map(row).join('') : '<div class="empty"><p>Nenhuma nota encontrada.</p></div>';
      });
    }, 180);
  });
  if (q) search.focus();

  $('[data-sync]', view).addEventListener('click', async () => {
    const s = await api('/api/sync', { method: 'POST', body: {} });
    toast(`Vault sincronizado: ${s.added} novas, ${s.updated} atualizadas, ${s.moved} movidas${s.missing ? `, ${s.missing} ausentes` : ''}.`, 'good');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  $('[data-open-vault]', view).addEventListener('click', () => api('/api/vault/open', { method: 'POST', body: {} }));
  $('[data-new-folder]', view)?.addEventListener('click', async () => {
    const name = await promptDialog(`Nova pasta em ${where}`);
    if (!name) return;
    try {
      const r = await api('/api/folders', { method: 'POST', body: { para, folder: folder ? `${folder}/${name}` : name } });
      location.hash = link(para, r.folder);
    } catch (err) { toast(err.message, 'error'); }
  });

  async function importPdfs(files) {
    const created = await importPdfFiles(files, { para: para || 'inbox', folder });
    if (!created.length) return;
    if (created.length === 1) {
      toast('PDF importado. Revise a nota e escreva seu resumo.', 'good');
      location.hash = `#/nota/${created[0].noteId}`;
    } else {
      toast(`${created.length} PDFs importados.`, 'good');
      dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }
  $('[data-pdf]', view).addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; importPdfs(f); });

  const drop = $('[data-drop]', view);
  view.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  view.addEventListener('dragleave', (e) => { if (!view.contains(e.relatedTarget)) drop.classList.remove('over'); });
  view.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const all = [...e.dataTransfer.files];
    const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
    const files = all.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (pdfs.length) await importPdfs(pdfs);
    if (!files.length) { if (!pdfs.length) toast('Apenas arquivos .pdf, .md ou .txt.', 'error'); return; }
    let ok = 0;
    for (const f of files) {
      try {
        await api('/api/notes', { method: 'POST', body: { title: f.name.replace(/\.[^.]+$/, ''), para: para || 'inbox', folder, body: await f.text() } });
        ok++;
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
    }
    toast(`${ok} ${ok === 1 ? 'nota importada' : 'notas importadas'}.`, 'good');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function row(n) {
  const snippet = n.snippet ? `<small class="snippet">${esc(n.snippet).replace(/&lt;&lt;/g, '<mark>').replace(/&gt;&gt;/g, '</mark>')}</small>` : '';
  return `<a class="list-item note-row" href="#/nota/${n.id}">
    <div class="grow"><div class="title">${esc(n.title)}${n.missing ? ' <span class="badge bad">arquivo ausente</span>' : ''}</div>
      ${snippet || `<small>${esc(app.meta.para[n.para].label)}${n.folder ? ' / ' + esc(n.folder) : ''}${n.loci ? ' · 📍 ' + esc(n.loci) : ''}</small>`}</div>
    <span class="meta">${n.qa_count} flashcards<br>${n.para === 'archives' ? 'arquivada' : 'próxima ' + relDays(n.due)}</span>
    ${memoryBadge(n)}
  </a>`;
}
