import { api, h, icon, pct, tooltips, memoryBadge, relDays, toast } from '../ui.js';
import { esc } from '../md.js';
import { app } from '../main.js';

const CONF_LABEL = ['', 'Chutando', 'Inseguro', 'Confiante', 'Certeza'];
const CONF_EXPECTED = [0, 0.25, 0.5, 0.8, 0.95];

export async function renderToday(view) {
  const d = await api('/api/dashboard');
  const t = d.today;
  const doneRatio = t.done + t.total ? Math.round((t.done / (t.done + t.total)) * 100) : 100;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const fresh = !d.totals.cards;

  view.append(h(`<div class="page">
    <section class="card hero">
      <div class="ring" style="--p:${doneRatio}" role="img" aria-label="${doneRatio}% da revisão de hoje concluída"><div><b>${t.total}</b><small>pendentes</small></div></div>
      <div>
        <h1>${hello}!</h1>
        <p>${fresh ? 'Comece criando sua primeira nota — cada nota vira um cartão de lembrança, e linhas <code>pergunta :: resposta</code> viram flashcards.'
          : t.total ? `Você tem <strong>${t.total}</strong> ${t.total === 1 ? 'cartão' : 'cartões'} para hoje (${[t.review && `${t.review} em revisão`, t.learning && `${t.learning} reaprendendo`, t.new && `${t.new} ${t.new === 1 ? 'novo' : 'novos'}`].filter(Boolean).join(', ')}) — cerca de <strong>${t.estimatedMinutes} min</strong>.`
          : `Tudo em dia${t.done ? ` — ${t.done} ${t.done === 1 ? 'revisão feita' : 'revisões feitas'} hoje` : ''}. A próxima leva aparece ${nextDueLabel(d.forecast)}.`}</p>
      </div>
      <div class="row">${fresh ? `<a class="btn primary lg" href="#/nova">${icon('plus')} Nova nota</a>`
        : t.total ? `<a class="btn primary lg" href="#/revisar">${icon('review')} Começar revisão</a>`
        : `<a class="btn lg" href="#/notas">${icon('notes')} Explorar notas</a>`}</div>
    </section>

    <section class="grid cols-4">
      ${stat('flame', 'Sequência', `${d.streak}`, d.streak === 1 ? 'dia seguido' : 'dias seguidos')}
      ${stat('today', 'Retenção real (30 d)', pct(d.retention), d.retention == null ? 'sem revisões maduras ainda' : `meta ${pct(d.desiredRetention)} · previsto ${pct(d.predictedRetention)}`)}
      ${stat('notes', 'Cartões ativos', `${d.totals.cards || 0}`, `${d.totals.mature || 0} maduros (≥ 21 d) · ${d.totals.fresh || 0} novos`)}
      ${stat('review', 'Revisões (30 d)', `${d.reviews30}`, d.totals.difficulty ? `dificuldade média ${d.totals.difficulty.toFixed(1).replace('.', ',')}/10` : 'dificuldade —')}
    </section>

    <section class="grid main-side">
      <div class="card">
        <div class="card-head"><h2>Previsão de revisões</h2><small>próximos 30 dias · inclui atrasados em “hoje”</small></div>
        ${forecastChart(d.forecast)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Ilusões de competência</h2><small>alta confiança + esqueci</small></div>
        ${d.alerts.length ? d.alerts.map(alertItem).join('') : '<p class="muted" style="margin:0">Nenhum alerta. Sua confiança está batendo com o que você realmente lembra.</p>'}
      </div>
    </section>

    <section class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>Calibração metacognitiva</h2><small>últimos 12 meses</small></div>
        ${calibration(d.calibration)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Atividade</h2><small>revisões por dia · 26 semanas</small></div>
        ${heatmap(d.heatmap)}
      </div>
    </section>

    <section class="grid main-side">
      <div class="card">
        <div class="card-head"><h2>Notas recentes</h2><a href="#/notas">ver todas</a></div>
        <div class="list">${d.recentNotes.length ? d.recentNotes.map(noteItem).join('') : '<p class="muted" style="margin:0">Nenhuma nota ainda.</p>'}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>PARA</h2></div>
        <div class="para-pills" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          ${d.para.map((p) => `<a class="para-pill" href="#/notas?para=${p.key}"><b>${p.total}</b><span>${esc(p.label)}</span></a>`).join('')}
        </div>
      </div>
    </section>
  </div>`));

  tooltips(view);
  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resolve]');
    if (!btn) return;
    await api(`/api/alerts/${btn.dataset.resolve}/resolve`, { method: 'POST', body: {} });
    btn.closest('.alert-item').remove();
    toast('Alerta resolvido.');
  });
}

function stat(ic, label, value, sub) {
  return `<div class="card stat"><span class="label">${icon(ic, 15)} ${label}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;
}

function nextDueLabel(forecast) {
  const i = forecast.findIndex((f, idx) => idx > 0 && f.count);
  return i === -1 ? 'quando você criar novas notas' : i === 1 ? 'amanhã' : `em ${i} dias`;
}

function forecastChart(data) {
  const W = 640, H = 180, padL = 28, padB = 22, padT = 8;
  const max = Math.max(4, ...data.map((d) => d.count));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / data.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const bars = data.map((d, i) => {
    const x = padL + i * bw;
    const bh = H - padB - y(d.count);
    const w = Math.max(2, bw - 2);
    const label = i === 0 ? 'Hoje' : fmt(d.date);
    const tip = `${label}: ${d.count} ${d.count === 1 ? 'cartão' : 'cartões'}`;
    // barra com topo arredondado de 4px e base reta no eixo
    const path = d.count ? `<path class="bar${i === 0 ? ' today' : ''}" d="M${x},${H - padB} v${-Math.max(bh - 4, 0)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${Math.max(bh - 4, 0)} z"/>` : '';
    const tick = i % 7 === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${i === 0 ? 'hoje' : new Date(`${d.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</text>` : '';
    return `<g><rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" data-tip="${esc(tip)}"/>${path}${tick}</g>`;
  }).join('');
  const table = `<table class="sr-only"><caption>Cartões previstos por dia</caption>${data.map((d) => `<tr><td>${d.date}</td><td>${d.count}</td></tr>`).join('')}</table>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Previsão de revisões nos próximos 30 dias">${grid}${bars}</svg>${table}`;
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

function heatmap(heat) {
  const days = 26 * 7;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1) - start.getDay()); // começa num domingo
  const values = Object.values(heat);
  const max = Math.max(1, ...values);
  const cells = [];
  for (let d = new Date(start); d <= today || d.getDay() !== 0; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const n = heat[key] || 0;
    const level = n ? Math.min(4, Math.ceil((n / max) * 4)) : 0;
    const future = d > today;
    cells.push(`<i data-l="${level}" class="${future ? 'future' : ''}" ${future ? '' : `data-tip="${d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}: ${n} ${n === 1 ? 'revisão' : 'revisões'}"`}></i>`);
    if (cells.length > 400) break;
  }
  return `<div class="heatmap" role="img" aria-label="Revisões por dia nas últimas 26 semanas">${cells.join('')}</div>
    <div class="legend">menos <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> mais</div>`;
}

function calibration(rows) {
  if (!rows.some((r) => r.n)) {
    return '<p class="muted" style="margin:0">Marque sua confiança antes de ver a resposta durante as revisões. Aqui você verá se “ter certeza” realmente significa acertar.</p>';
  }
  return `<div class="calib">${rows.map((r) => `
    <div class="calib-row" data-tip="${CONF_LABEL[r.confidence]}: ${r.n} respostas · acerto real ${pct(r.success)} · esperado ~${pct(CONF_EXPECTED[r.confidence])}">
      <span>${CONF_LABEL[r.confidence]}</span>
      <div class="calib-track"><div class="calib-fill" style="width:${(r.success ?? 0) * 100}%"></div><div class="calib-mark" style="left:${CONF_EXPECTED[r.confidence] * 100}%"></div></div>
      <span class="val">${r.n ? pct(r.success) : '—'} <small>(${r.n})</small></span>
    </div>`).join('')}</div>
    <div class="legend"><i style="background:var(--accent)"></i> acerto real <i class="tick"></i> esperado para o nível de confiança</div>`;
}

function alertItem(a) {
  return `<div class="alert-item">${icon('alert', 16)}<div>
    <a href="#/nota/${a.note_id}"><strong>${esc(a.title)}</strong></a>
    <p>${a.kind === 'qa' ? esc(a.prompt) + ' · ' : ''}marcou “${CONF_LABEL[a.confidence]}” e esqueceu · ${relDays(a.reviewed_at)}</p></div>
    <button class="btn sm ghost" data-resolve="${a.id}">Resolver</button></div>`;
}

function noteItem(n) {
  return `<a class="list-item" href="#/nota/${n.id}"><div class="grow"><div class="title">${esc(n.title)}</div>
    <small>${esc(app.meta.para[n.para].label)}${n.folder ? ' / ' + esc(n.folder) : ''} · ${n.qa_count} flashcards · próxima ${relDays(n.due)}</small></div>${memoryBadge(n)}</a>`;
}
