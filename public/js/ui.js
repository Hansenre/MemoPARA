import { esc } from './md.js';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(message, kind = 'info', ms = 3200) {
  let host = $('#toasts');
  if (!host) { host = h('<div id="toasts" role="status" aria-live="polite"></div>'); document.body.append(host); }
  const el = h(`<div class="toast ${kind}">${esc(message)}</div>`);
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

export function confirmDialog(message, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="dialog"><p>${esc(message)}</p><div class="row end">
      <button class="btn ghost" value="no">Cancelar</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(ok)}</button></div></dialog>`);
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target.value) dlg.close(e.target.value); });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    dlg.showModal();
    $('[value=yes]', dlg).focus();
  });
}

export function promptDialog(message, value = '') {
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="dialog"><form method="dialog"><label>${esc(message)}<input name="v" value="${esc(value)}" autocomplete="off"></label>
      <div class="row end"><button type="button" class="btn ghost" data-cancel>Cancelar</button><button class="btn primary" value="ok">OK</button></div></form></dialog>`);
    document.body.append(dlg);
    $('[data-cancel]', dlg).addEventListener('click', () => dlg.close(''));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? $('input', dlg).value.trim() : null); dlg.remove(); });
    dlg.showModal();
  });
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
export function relDays(iso) {
  if (!iso) return '—';
  const days = Math.round((new Date(iso) - Date.now()) / 86_400_000);
  if (Math.abs(days) < 1) {
    const min = Math.round((new Date(iso) - Date.now()) / 60_000);
    return Math.abs(min) < 60 ? rtf.format(min, 'minute') : 'hoje';
  }
  if (Math.abs(days) < 45) return rtf.format(days, 'day');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}

export function fmtInterval(days) {
  if (!days) return '10 min';
  if (days < 30) return `${days} d`;
  if (days < 365) return `${(days / 30).toFixed(days < 60 ? 1 : 0).replace('.', ',')} m`;
  return `${(days / 365).toFixed(1).replace('.', ',')} a`;
}

export const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export const STATE_LABEL = ['Nova', 'Aprendendo', 'Revisão', 'Reaprendendo'];

export function memoryBadge(card) {
  if (!card || card.state == null) return '';
  if (card.state === 0) return '<span class="badge new">nova</span>';
  const r = card.retrievability ?? 0;
  const cls = r >= 0.9 ? 'ok' : r >= 0.75 ? 'warn' : 'bad';
  return `<span class="badge ${cls}" title="Chance estimada de lembrar agora">${pct(r)}</span>`;
}

export const icons = {
  today: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  review: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  notes: '<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 21v-5h5M21 3v5h-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4 3 7 7 7z"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 4.5v18"/><path d="M9 7h7M9 11h5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'
};
export const icon = (name, size = 18) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

// Tooltip único para qualquer elemento com data-tip (gráficos, heatmap).
export function tooltips(root) {
  let tip = $('.tooltip');
  if (!tip) { tip = h('<div class="tooltip" hidden></div>'); document.body.append(tip); }
  root.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    tip.textContent = t.dataset.tip;
    tip.style.left = `${Math.min(Math.max(r.left + r.width / 2, 80), innerWidth - 80)}px`;
    tip.style.top = `${r.top}px`;
    tip.hidden = false;
  });
  root.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) tip.hidden = true; });
}
