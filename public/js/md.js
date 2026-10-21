// Renderizador Markdown mínimo e seguro: todo texto é escapado antes de virar HTML.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Links relativos (ex.: o PDF de uma apostila) são resolvidos a partir da pasta da nota
// e servidos pelo app em /vault/... ; outros esquemas (javascript:, file:) viram texto.
function resolveHref(rawHref, base) {
  const href = rawHref.replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(href)) return { url: href, external: true };
  if (/^[a-z][\w+.-]*:/i.test(href) || base == null) return null;
  const parts = base ? base.split('/') : [];
  for (const seg of href.split('#')[0].split('/')) {
    let s;
    try { s = decodeURIComponent(seg); } catch { s = seg; }
    if (s === '..') parts.pop();
    else if (s && s !== '.') parts.push(s);
  }
  return { url: `/vault/${parts.map(encodeURIComponent).join('/')}`, external: false };
}

function inline(text, base) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (m, alt, href) => {
      const r = resolveHref(href, base);
      return r ? `<img src="${esc(r.url)}" alt="${alt}" loading="lazy">` : alt;
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (m, label, href) => {
      const r = resolveHref(href, base);
      return r ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(src, { cards = true, base = null } = {}) {
  const inl = (t) => inline(t, base);
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inl(para.join(' '))}</p>`); para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      flush();
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (cards && (m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.+?)\s+::\s+(.+?)\s*$/))) {
      flush();
      out.push(`<div class="md-card"><span class="q">${inl(m[1])}</span><span class="a">${inl(m[2])}</span></div>`);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'), { cards })}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !(cards && /\s::\s/.test(lines[i]))) {
        const item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task ? `<li class="task"><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inl(task[2])}</li>` : `<li>${inl(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|')) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inl(h)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}
