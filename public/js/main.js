import { api, $, $$, h, icon, toast, memoryBadge } from './ui.js';
import { esc } from './md.js';
import { renderToday } from './views/today.js';
import { renderReview } from './views/review.js';
import { renderNotes } from './views/notes.js';
import { renderEditor } from './views/editor.js';
import { renderSettings } from './views/settings.js';
import { renderApostilas, renderApostila } from './views/apostilas.js';

export const app = { meta: null, cleanup: null };

const NAV = [
  { href: '#/', label: 'Hoje', icon: 'today', key: 'today' },
  { href: '#/revisar', label: 'Revisar', icon: 'review', key: 'review' },
  { href: '#/notas', label: 'Notas', icon: 'notes', key: 'notes' },
  { href: '#/apostilas', label: 'Apostilas', icon: 'book', key: 'apostilas' },
  { href: '#/config', label: 'Ajustes', icon: 'settings', key: 'settings' }
];

function shell() {
  document.body.append(h(`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/"><img src="/icon.svg" alt="" width="28" height="28"><span>MemoPARA</span></a>
      <button class="search-trigger" id="open-palette">${icon('search', 16)}<span>Buscar notas</span><kbd>Ctrl K</kbd></button>
      <nav>${NAV.map((n) => `<a href="${n.href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span>${n.key === 'review' ? '<b class="count" id="due-count" hidden></b>' : ''}</a>`).join('')}</nav>
      <div class="sidebar-foot">
        <a class="btn primary block" href="#/nova">${icon('plus', 16)} Nova nota</a>
        <button class="btn ghost icon-only" id="theme-toggle" title="Alternar tema"></button>
      </div>
    </aside>
    <main id="view" tabindex="-1"></main>
  </div>`));
  $('#open-palette').addEventListener('click', openPalette);
  $('#theme-toggle').addEventListener('click', toggleTheme);
  paintThemeButton();
}

// ---------- tema ----------
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function paintThemeButton() { $('#theme-toggle').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon'); }
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('memopara-theme', next); } catch { /* sem storage */ }
  paintThemeButton();
}

// ---------- roteador ----------
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [, section, id] = hash.split('?')[0].split('/');
  app.cleanup?.();
  app.cleanup = null;
  // Cada tela recebe um contêiner novo: listeners da tela anterior não sobrevivem
  // (antes o autosave do editor anterior podia gravar os campos da tela seguinte).
  const old = $('#view');
  const view = old.cloneNode(false);
  old.replaceWith(view);
  const key = { '': 'today', revisar: 'review', notas: 'notes', nota: 'notes', nova: 'notes', apostilas: 'apostilas', apostila: 'apostilas', config: 'settings' }[section ?? ''] ?? 'today';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  try {
    if (!section) await renderToday(view);
    else if (section === 'revisar') await renderReview(view, { noteId: id });
    else if (section === 'notas') await renderNotes(view, parseQuery(hash));
    else if (section === 'nota') await renderEditor(view, { id: decodeURIComponent(id || ''), autoAi: parseQuery(hash).ia === '1' });
    else if (section === 'nova') await renderEditor(view, { draft: parseQuery(hash) });
    else if (section === 'apostilas') await renderApostilas(view);
    else if (section === 'apostila') await renderApostila(view, { id: decodeURIComponent(id || '') });
    else if (section === 'config') await renderSettings(view);
    else await renderToday(view);
  } catch (err) {
    view.innerHTML = `<div class="empty"><h2>Algo deu errado</h2><p>${esc(err.message)}</p><a class="btn" href="#/">Voltar</a></div>`;
  }
  view.focus({ preventScroll: true });
  refreshDueCount();
}

function parseQuery(hash) {
  const q = hash.split('?')[1];
  return q ? Object.fromEntries(new URLSearchParams(q)) : {};
}

export async function refreshDueCount() {
  try {
    const { counts } = await api('/api/queue?limit=1');
    const n = counts.learning + counts.review + counts.new;
    const el = $('#due-count');
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : n;
    document.title = n ? `(${n}) MemoPARA` : 'MemoPARA';
  } catch { /* servidor fora do ar */ }
}

// ---------- paleta de comandos (Ctrl+K) ----------
function openPalette() {
  if ($('.palette')) return;
  const dlg = h(`<dialog class="palette"><div class="palette-input">${icon('search')}<input placeholder="Buscar notas ou comandos…" autocomplete="off" spellcheck="false"></div><ul class="palette-list"></ul>
    <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> fechar</span></div></dialog>`);
  document.body.append(dlg);
  const input = $('input', dlg);
  const list = $('ul', dlg);
  const commands = [
    { label: 'Começar revisão', hint: 'R', go: '#/revisar' },
    { label: 'Nova nota', hint: 'N', go: '#/nova' },
    { label: 'Painel de hoje', go: '#/' },
    { label: 'Explorar notas PARA', go: '#/notas' },
    { label: 'Apostilas (fotos → PDF)', go: '#/apostilas' },
    { label: 'Ajustes e backup', go: '#/config' }
  ];
  let items = [];
  let sel = 0;
  let timer;
  const paint = () => {
    list.innerHTML = items.map((it, i) => `<li class="${i === sel ? 'sel' : ''}" data-i="${i}">
      <span class="pl-label">${it.html ?? esc(it.label)}</span>${it.meta ? `<span class="pl-meta">${it.meta}</span>` : ''}${it.hint ? `<kbd>${it.hint}</kbd>` : ''}</li>`).join('')
      || '<li class="muted">Nada encontrado</li>';
    $('.sel', list)?.scrollIntoView({ block: 'nearest' });
  };
  const search = async () => {
    const q = input.value.trim();
    const cmds = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
    if (!q) { items = cmds; sel = 0; paint(); return; }
    const notes = await api(`/api/notes?q=${encodeURIComponent(q)}&limit=12`).catch(() => []);
    items = [...notes.map((n) => ({
      go: `#/nota/${n.id}`,
      html: `<strong>${esc(n.title)}</strong>${n.snippet ? `<small>${esc(n.snippet).replace(/&lt;&lt;/g, '<mark>').replace(/&gt;&gt;/g, '</mark>')}</small>` : ''}`,
      meta: `${esc(app.meta.para[n.para].label)}${n.folder ? ' / ' + esc(n.folder) : ''} ${memoryBadge(n)}`
    })), ...cmds];
    sel = 0;
    paint();
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); paint(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); paint(); e.preventDefault(); }
    if (e.key === 'Enter' && items[sel]) { location.hash = items[sel].go; dlg.close(); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) { location.hash = items[li.dataset.i].go; dlg.close(); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  search();
}

const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || $('dialog[open]')) return;
  if (location.hash.startsWith('#/revisar')) return; // a tela de revisão tem seus próprios atalhos
  if (e.key === 'n') { location.hash = '#/nova'; e.preventDefault(); }
  if (e.key === 'r') { location.hash = '#/revisar'; e.preventDefault(); }
});

// Mantém o servidor vivo enquanto a janela estiver aberta (ele encerra sozinho quando aberto pelo atalho).
setInterval(() => fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}), 60_000);
setInterval(refreshDueCount, 5 * 60_000);

(async function init() {
  try {
    app.meta = await api('/api/meta');
  } catch {
    document.body.innerHTML = '<div class="empty"><h2>Servidor indisponível</h2><p>Abra o MemoPARA pelo atalho da área de trabalho.</p></div>';
    return;
  }
  shell();
  window.addEventListener('hashchange', route);
  route();
})();

export { toast };
