import { api, h, $, $$, icon, toast, confirmDialog, relDays } from '../ui.js';
import { esc } from '../md.js';
import { app } from '../main.js';

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|bmp|avif)$/;

// ---------- lista ----------
export async function renderApostilas(view) {
  const list = await api('/api/apostilas');
  view.append(h(`<div class="page">
    <div class="page-head">
      <div><h1>Apostilas</h1><p>Fotografe ou arraste as páginas, ajuste a ordem e gere um PDF na pasta PARA, com uma nota de estudo ligada a ele.</p></div>
      <button class="btn primary" data-new>${icon('plus', 16)} Nova apostila</button>
    </div>
    ${list.length ? `<div class="ap-grid">${list.map((a) => `
      <a class="card ap-card" href="#/apostila/${a.id}">
        <div class="ap-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : icon('book', 32)}</div>
        <div class="ap-info">
          <strong>${esc(a.title)}</strong>
          <small>${esc(app.meta.para[a.para].label)}${a.folder ? ' / ' + esc(a.folder) : ''}</small>
          <small>${a.pages} ${a.pages === 1 ? 'página' : 'páginas'} · ${a.generated_at ? `PDF ${relDays(a.generated_at)}` : 'PDF ainda não gerado'}</small>
        </div>
      </a>`).join('')}</div>`
    : `<div class="card empty">${icon('book', 36)}<h2>Nenhuma apostila ainda</h2><p>Crie uma apostila, adicione as fotos das páginas (arquivo, câmera ou Ctrl+V) e gere o PDF.</p></div>`}
  </div>`));
  $('[data-new]', view).addEventListener('click', newApostilaDialog);
}

async function newApostilaDialog() {
  const tree = await api('/api/tree');
  const dlg = h(`<dialog class="dialog"><form method="dialog">
    <h2 style="margin-bottom:14px">Nova apostila</h2>
    <label>Nome<input name="title" required maxlength="150" placeholder="ex.: Bioquímica — Módulo 2" autocomplete="off"></label>
    <label>Categoria PARA<select name="para">${Object.entries(app.meta.para).filter(([k]) => k !== 'archives')
      .map(([k, v]) => `<option value="${k}" ${k === 'resources' ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
    <label>Pasta (opcional)<input name="folder" list="ap-folders" placeholder="ex.: Faculdade/Bioquímica" autocomplete="off"><datalist id="ap-folders"></datalist></label>
    <div class="row end"><button type="button" class="btn ghost" data-cancel>Cancelar</button><button class="btn primary" value="ok">Criar</button></div>
  </form></dialog>`);
  document.body.append(dlg);
  const fill = () => { $('#ap-folders', dlg).innerHTML = (tree.find((s) => s.key === dlg.querySelector('[name=para]').value)?.folders || []).map((f) => `<option value="${esc(f.path)}">`).join(''); };
  fill();
  $('[name=para]', dlg).addEventListener('change', fill);
  $('[data-cancel]', dlg).addEventListener('click', () => dlg.close(''));
  dlg.addEventListener('close', async () => {
    const data = Object.fromEntries(new FormData($('form', dlg)));
    dlg.remove();
    if (dlg.returnValue !== 'ok' || !data.title?.trim()) return;
    try {
      const a = await api('/api/apostilas', { method: 'POST', body: data });
      location.hash = `#/apostila/${a.id}`;
    } catch (err) { toast(err.message, 'error'); }
  });
  dlg.showModal();
}

// ---------- área de trabalho ----------
export async function renderApostila(view, { id }) {
  let a = await api(`/api/apostilas/${encodeURIComponent(id)}`);
  const tree = await api('/api/tree');
  if (!view.isConnected) return;
  let busy = false;

  view.append(h(`<div class="page">
    <div class="editor-head">
      <a class="btn ghost sm" href="#/apostilas">← Apostilas</a>
      <input class="title-input" name="title" value="${esc(a.title)}" maxlength="150" aria-label="Nome da apostila">
      <span class="muted" data-status style="font-size:13px"></span>
    </div>
    <div class="fields" style="grid-template-columns:180px 1fr">
      <label>Categoria PARA<select name="para">${Object.entries(app.meta.para).map(([k, v]) => `<option value="${k}" ${k === a.para ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      <label>Pasta<input name="folder" list="ap-folder-list" value="${esc(a.folder)}" placeholder="opcional" autocomplete="off"><datalist id="ap-folder-list"></datalist></label>
    </div>
    <div class="grid main-side">
      <section class="card ap-work" data-drop-zone>
        <div class="toolbar">
          <label class="btn primary" style="flex-direction:row;font-size:14px;color:var(--on-accent)">${icon('plus', 16)} Adicionar fotos
            <input type="file" accept="image/*" multiple hidden data-files></label>
          <button class="btn" data-camera>${icon('camera', 16)} Câmera</button>
          <span class="muted" style="font-size:13px">ou arraste as fotos aqui · <kbd>Ctrl</kbd>+<kbd>V</kbd> cola uma imagem</span>
        </div>
        <div class="ap-progress" data-progress hidden><div class="progress"><i></i></div><span></span></div>
        <div class="ap-pages" data-pages></div>
      </section>
      <aside class="card ap-side" data-side></aside>
    </div>
  </div>`));

  const status = $('[data-status]', view);
  const fillFolders = () => {
    $('#ap-folder-list', view).innerHTML = (tree.find((s) => s.key === $('[name=para]', view).value)?.folders || []).map((f) => `<option value="${esc(f.path)}">`).join('');
  };
  fillFolders();
  paintPages();
  paintSide();

  // ---- campos: salvam ao sair do campo ----
  view.addEventListener('change', async (e) => {
    if (!['title', 'para', 'folder'].includes(e.target.name)) return;
    if (e.target.name === 'para') fillFolders();
    try {
      a = await api(`/api/apostilas/${a.id}`, { method: 'PUT', body: { [e.target.name]: e.target.value } });
      $('[name=folder]', view).value = a.folder;
      status.textContent = 'Salvo';
      paintSide();
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---- adicionar páginas ----
  $('[data-files]', view).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('[data-camera]', view).addEventListener('click', openCamera);
  const zone = $('[data-drop-zone]', view);
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    zone.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });
  const onPaste = (e) => {
    if (document.querySelector('dialog[open]')) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (files.length) { e.preventDefault(); addFiles(files.map((f, i) => new File([f], `colado-${Date.now()}-${i}.png`, { type: f.type }))); }
  };
  document.addEventListener('paste', onPaste);
  app.cleanup = () => document.removeEventListener('paste', onPaste);

  async function addFiles(files) {
    const images = files.filter((f) => IMAGE_TYPES.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name))
      .sort((x, y) => x.name.localeCompare(y.name, 'pt-BR', { numeric: true }));
    const skipped = files.length - images.length;
    if (skipped) toast(`${skipped} ${skipped === 1 ? 'arquivo ignorado' : 'arquivos ignorados'} (só imagens).`, 'error');
    if (!images.length) return;
    await withProgress(images.length, 'Enviando', async (step) => {
      for (const f of images) {
        try {
          const jpeg = await toJpeg(f);
          a = await api(`/api/apostilas/${a.id}/pages`, { method: 'POST', body: { image: jpeg, name: f.name } });
        } catch (err) {
          toast(/heic|heif/i.test(f.name) ? `${f.name}: fotos HEIC do iPhone não abrem aqui — exporte como JPG.` : `${f.name}: ${err.message}`, 'error', 6000);
        }
        step();
      }
    });
    paintPages();
    paintSide();
  }

  async function withProgress(total, label, fn) {
    const box = $('[data-progress]', view);
    let done = 0;
    const paint = () => { $('i', box).style.width = `${(done / total) * 100}%`; $('span', box).textContent = `${label} ${Math.min(done + 1, total)} de ${total}…`; };
    busy = true;
    box.hidden = false;
    paint();
    try { await fn(() => { done++; paint(); }); } finally { box.hidden = true; busy = false; }
  }

  // ---- páginas ----
  function paintPages() {
    const grid = $('[data-pages]', view);
    if (!a.pages.length) {
      grid.innerHTML = `<div class="ap-empty">${icon('camera', 32)}<p>Nenhuma página ainda.<br>Adicione fotos, use a câmera ou cole uma imagem.</p></div>`;
      return;
    }
    grid.innerHTML = a.pages.map((p, i) => `
      <figure class="ap-page" draggable="true" data-page="${p.id}">
        <div class="ap-img"><img src="${esc(p.url)}" alt="Página ${i + 1}" loading="lazy" draggable="false"></div>
        <figcaption>
          <b>${i + 1}</b>${p.ocr_text ? '<span class="badge ok" title="Texto extraído">OCR</span>' : ''}
          <span class="spacer"></span>
          <button class="icon-btn" data-act="left" title="Mover para trás" ${i === 0 ? 'disabled' : ''}>‹</button>
          <button class="icon-btn" data-act="right" title="Mover para frente" ${i === a.pages.length - 1 ? 'disabled' : ''}>›</button>
          <button class="icon-btn" data-act="ccw" title="Girar à esquerda">↺</button>
          <button class="icon-btn" data-act="cw" title="Girar à direita">↻</button>
          <button class="icon-btn danger" data-act="del" title="Excluir página">✕</button>
        </figcaption>
      </figure>`).join('');
  }

  const grid = $('[data-pages]', view);
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || busy) return;
    const pageId = Number(btn.closest('[data-page]').dataset.page);
    const idx = a.pages.findIndex((p) => p.id === pageId);
    const p = a.pages[idx];
    try {
      busy = true;
      if (btn.dataset.act === 'left' || btn.dataset.act === 'right') {
        const ids = a.pages.map((x) => x.id);
        const to = idx + (btn.dataset.act === 'left' ? -1 : 1);
        [ids[idx], ids[to]] = [ids[to], ids[idx]];
        a = await api(`/api/apostilas/${a.id}/order`, { method: 'PUT', body: { pageIds: ids } });
      } else if (btn.dataset.act === 'del') {
        busy = false;
        if (!(await confirmDialog(`Excluir a página ${idx + 1}?`, { ok: 'Excluir', danger: true }))) return;
        busy = true;
        a = await api(`/api/apostilas/${a.id}/pages/${pageId}`, { method: 'DELETE' });
      } else {
        const rotation = (p.rotation + (btn.dataset.act === 'cw' ? 90 : 270)) % 360;
        btn.closest('.ap-page').classList.add('working');
        const body = { rotation };
        if (rotation) body.image = await toJpeg(await (await fetch(p.original_url)).blob(), { rotation });
        a = await api(`/api/apostilas/${a.id}/pages/${pageId}`, { method: 'PUT', body });
      }
      paintPages();
      paintSide();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
  });

  // arrastar miniaturas para reordenar
  let dragId = null;
  grid.addEventListener('dragstart', (e) => {
    const fig = e.target.closest('[data-page]');
    if (!fig) return;
    dragId = Number(fig.dataset.page);
    fig.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });
  grid.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const over = e.target.closest('[data-page]');
    const dragging = $('.dragging', grid);
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(dragging, e.clientX > r.left + r.width / 2 ? over.nextSibling : over);
  });
  grid.addEventListener('dragend', async () => {
    if (dragId == null) return;
    dragId = null;
    const ids = $$('[data-page]', grid).map((f) => Number(f.dataset.page));
    if (ids.join() === a.pages.map((p) => p.id).join()) { paintPages(); return; }
    try { a = await api(`/api/apostilas/${a.id}/order`, { method: 'PUT', body: { pageIds: ids } }); } catch (err) { toast(err.message, 'error'); }
    paintPages();
    paintSide();
  });

  // ---- painel lateral: gerar PDF e nota ----
  function paintSide() {
    const side = $('[data-side]', view);
    const dir = [app.meta.para[a.para].dir, a.folder].filter(Boolean).join('/');
    const stale = a.generated_at && a.updated_at > a.generated_at;
    const missingOcr = a.pages.filter((p) => !p.ocr_text).length;
    side.innerHTML = `
      <h2>PDF e nota</h2>
      <p class="muted" style="margin:0;font-size:13px">O PDF vai para <span class="path">${esc(dir)}/</span> e a nota de estudo fica ao lado, com o link para ele.</p>
      <label class="check"><input type="checkbox" data-ocr ${a.ocr.available ? '' : 'disabled'}> Extrair o texto das fotos (OCR)</label>
      ${a.ocr.available
        ? `<small class="muted">${esc(a.ocr.version)} · ${esc(a.ocr.langs.join(' + ') || 'idioma padrão')}${missingOcr < a.pages.length ? ` · ${a.pages.length - missingOcr} de ${a.pages.length} páginas já lidas` : ''}. O texto entra na nota e fica pesquisável.</small>`
        : '<small class="muted">Instale o <a href="https://github.com/UB-Mannheim/tesseract/wiki" target="_blank" rel="noopener noreferrer">Tesseract para Windows</a> marcando o idioma Português e reabra o app para ativar.</small>'}
      <button class="btn primary lg" data-generate ${a.pages.length ? '' : 'disabled'}>${a.generated_at ? 'Gerar de novo' : 'Gerar PDF e nota'}</button>
      <button class="btn" data-summarize ${a.pages.length ? '' : 'disabled'} title="Lê o texto das páginas (OCR), atualiza a nota e pede ao modelo local um resumo e flashcards para você revisar">✨ Resumir apostila (IA local)</button>
      ${a.ocr.available ? '' : '<small class="muted">Para resumir, o app precisa do OCR (Tesseract) para ler o texto das fotos.</small>'}
      ${a.generated_at ? `
        <div class="ap-result">
          <div class="row"><span class="badge ${stale ? 'warn' : 'ok'}">${stale ? 'mudou desde o último PDF' : 'PDF em dia'}</span><small class="muted">gerado ${relDays(a.generated_at)}</small></div>
          ${a.pdf_url ? `<a class="btn" href="${esc(a.pdf_url)}" target="_blank" rel="noopener">${icon('notes', 16)} Ver PDF</a>
            <button class="btn" data-open-pdf>Abrir no leitor de PDF</button>
            <button class="btn" data-reveal-pdf>${icon('folder', 16)} Mostrar no Explorer</button>` : '<small class="muted">O arquivo PDF não foi encontrado — gere de novo.</small>'}
          ${a.note ? `<a class="btn" href="#/nota/${a.note.id}">Abrir a nota “${esc(a.note.title)}” →</a>` : ''}
        </div>` : ''}
      <hr>
      <button class="btn ghost danger sm" data-delete>Excluir apostila</button>
      <small class="muted">Excluir remove só as fotos (vão para a lixeira do vault). O PDF e a nota continuam.</small>`;
    $('[data-generate]', side)?.addEventListener('click', () => generate());
    $('[data-summarize]', side)?.addEventListener('click', summarize);
    $('[data-open-pdf]', side)?.addEventListener('click', () => api(`/api/apostilas/${a.id}/open-pdf`, { method: 'POST', body: {} }).catch((err) => toast(err.message, 'error')));
    $('[data-reveal-pdf]', side)?.addEventListener('click', () => api(`/api/apostilas/${a.id}/reveal-pdf`, { method: 'POST', body: {} }).catch((err) => toast(err.message, 'error')));
    $('[data-delete]', side).addEventListener('click', async () => {
      if (!(await confirmDialog(`Excluir a apostila “${a.title}”? As fotos vão para a lixeira do vault; o PDF e a nota continuam.`, { ok: 'Excluir', danger: true }))) return;
      await api(`/api/apostilas/${a.id}`, { method: 'DELETE' });
      location.hash = '#/apostilas';
    });
  }

  // Resumir = garantir o texto (OCR) na nota e abrir a nota já pedindo as sugestões à IA
  async function summarize() {
    if (busy) return;
    if (!a.ocr.available && a.pages.some((p) => !p.ocr_text)) {
      toast('Para resumir, o app precisa ler o texto das fotos: instale o Tesseract (veja INSTALAR.txt).', 'error', 7000);
      return;
    }
    if (await generate(true)) location.hash = `#/nota/${a.note.id}?ia=1`;
  }

  async function generate(forceOcr = false) {
    if (busy) return false;
    const useOcr = forceOcr || $('[data-ocr]', view)?.checked;
    try {
      if (useOcr) {
        const pending = a.pages.filter((p) => !p.ocr_text);
        if (pending.length) {
          await withProgress(pending.length, 'Lendo o texto da página', async (step) => {
            for (const p of pending) {
              try { await api(`/api/apostilas/${a.id}/pages/${p.id}/ocr`, { method: 'POST', body: {} }); }
              catch (err) { toast(`Página ${a.pages.indexOf(p) + 1}: ${err.message}`, 'error'); }
              step();
            }
          });
        }
      }
      busy = true;
      status.textContent = 'Gerando PDF…';
      const r = await api(`/api/apostilas/${a.id}/pdf`, { method: 'POST', body: { includeOcr: !!useOcr } });
      a = await api(`/api/apostilas/${a.id}`);
      status.textContent = '';
      toast(`PDF gerado (${(r.bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB) e nota ${a.note ? 'atualizada' : 'criada'}.`, 'good');
      paintPages();
      paintSide();
      return !!a.note;
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
      return false;
    } finally {
      busy = false;
    }
  }

  // ---- câmera ----
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Este navegador não dá acesso à câmera.', 'error'); return; }
    const dlg = h(`<dialog class="camera">
      <video autoplay playsinline muted></video>
      <div class="camera-bar">
        <select data-device aria-label="Câmera" hidden></select>
        <span class="muted" data-count>0 fotos</span>
        <span class="spacer"></span>
        <button class="btn" data-close>Concluir</button>
        <button class="btn primary lg" data-shot>${icon('camera', 18)} Capturar <kbd>Espaço</kbd></button>
      </div>
    </dialog>`);
    document.body.append(dlg);
    const video = $('video', dlg);
    let stream = null;
    let shots = 0;
    const stop = () => stream?.getTracks().forEach((t) => t.stop());
    const start = async (deviceId) => {
      stop();
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
          : { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      video.srcObject = stream;
    };
    try {
      await start();
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('[data-device]', dlg);
      if (cams.length > 1) {
        sel.hidden = false;
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
        sel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === current ? 'selected' : ''}>${esc(c.label || `Câmera ${i + 1}`)}</option>`).join('');
        sel.addEventListener('change', () => start(sel.value).catch((err) => toast(err.message, 'error')));
      }
    } catch (err) {
      dlg.remove();
      toast(err.name === 'NotAllowedError' ? 'Acesso à câmera negado. Libere a câmera nas permissões do navegador.' : err.name === 'NotFoundError' ? 'Nenhuma câmera encontrada.' : err.message, 'error', 6000);
      return;
    }
    const shoot = async () => {
      if (!video.videoWidth) return;
      dlg.classList.add('flash-shot');
      setTimeout(() => dlg.classList.remove('flash-shot'), 150);
      try {
        a = await api(`/api/apostilas/${a.id}/pages`, { method: 'POST', body: { image: await toJpeg(video), name: `camera-${Date.now()}.jpg` } });
        shots++;
        $('[data-count]', dlg).textContent = `${shots} ${shots === 1 ? 'foto' : 'fotos'}`;
        paintPages();
        paintSide();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('[data-shot]', dlg).addEventListener('click', shoot);
    $('[data-close]', dlg).addEventListener('click', () => dlg.close());
    dlg.addEventListener('keydown', (e) => { if (e.key === ' ' && e.target.tagName !== 'SELECT') { e.preventDefault(); shoot(); } });
    dlg.addEventListener('close', () => { stop(); dlg.remove(); });
    dlg.showModal();
    $('[data-shot]', dlg).focus();
  }
}

// Converte qualquer imagem (arquivo, vídeo da câmera) para JPEG, já girada, com no máximo 3000 px.
async function toJpeg(source, { rotation = 0, max = 3000, quality = 0.88 } = {}) {
  let img = source;
  if (source instanceof Blob) {
    try { img = await createImageBitmap(source, { imageOrientation: 'from-image' }); }
    catch { throw new Error('formato de imagem não suportado'); }
  }
  const w = img.videoWidth || img.width;
  const hgt = img.videoHeight || img.height;
  const scale = Math.min(1, max / Math.max(w, hgt));
  const sw = Math.round(w * scale);
  const sh = Math.round(hgt * scale);
  const rot = ((rotation % 360) + 360) % 360;
  const canvas = document.createElement('canvas');
  canvas.width = rot % 180 ? sh : sw;
  canvas.height = rot % 180 ? sw : sh;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG com transparência vira fundo branco
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
  img.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
