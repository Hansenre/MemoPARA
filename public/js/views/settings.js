import { api, h, $, toast, confirmDialog } from '../ui.js';
import { esc } from '../md.js';
import { app } from '../main.js';

const FIELDS = [
  { key: 'desiredRetention', label: 'Retenção desejada', help: 'Chance de lembrar no momento da revisão. Mais alta = revisões mais frequentes. 90% é o equilíbrio recomendado.', min: 0.8, max: 0.97, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'newPerDay', label: 'Cartões novos por dia', help: 'Limita quantos cartões inéditos entram por dia, para a carga não explodir.', min: 0, max: 100, step: 1, fmt: (v) => v },
  { key: 'firstReviewDelayDays', label: 'Primeira revisão após criar', help: 'Você acabou de estudar o conteúdo; esperar uma noite de sono ajuda a consolidar.', min: 0, max: 7, step: 1, fmt: (v) => (v == 0 ? 'no mesmo dia' : `${v} dia${v > 1 ? 's' : ''}`) },
  { key: 'dayRolloverHour', label: 'Virada do dia de estudo', help: 'Revisões feitas de madrugada contam para o dia anterior.', min: 0, max: 8, step: 1, fmt: (v) => `${v}h` },
  { key: 'maxInterval', label: 'Intervalo máximo', help: 'Teto para o espaçamento entre revisões.', min: 180, max: 36500, step: 1, fmt: (v) => (v >= 365 ? `${Math.round(v / 365)} anos` : `${v} dias`), list: [180, 365, 730, 1825, 3650, 36500] }
];

export async function renderSettings(view) {
  const settings = await api('/api/settings');
  const { paths } = app.meta;

  view.append(h(`<div class="page narrow">
    <div class="page-head"><div><h1>Ajustes</h1><p>Algoritmo, rotina e backup.</p></div></div>
    <section class="card">
      <div class="card-head"><h2>Agendamento (FSRS)</h2></div>
      ${FIELDS.map((f) => {
        const value = f.list ? f.list.indexOf(nearest(f.list, settings[f.key])) : settings[f.key];
        return `<div class="setting">
          <div><strong>${f.label}</strong> · <output data-out="${f.key}">${f.fmt(settings[f.key])}</output><p>${f.help}</p></div>
          <input type="range" name="${f.key}" min="${f.list ? 0 : f.min}" max="${f.list ? f.list.length - 1 : f.max}" step="${f.list ? 1 : f.step}" value="${value}" aria-label="${f.label}">
        </div>`;
      }).join('')}
    </section>
    <section class="card">
      <div class="card-head"><h2>Como funciona</h2></div>
      <div class="md" style="font-size:14px">
        <p>O MemoPARA usa o <strong>FSRS</strong> (Free Spaced Repetition Scheduler), o mesmo algoritmo do Anki moderno. Em vez de intervalos fixos (3, 10, 30, 60 dias), ele modela cada cartão com:</p>
        <ul>
          <li><strong>Estabilidade</strong> — quantos dias até sua chance de lembrar cair para 90%;</li>
          <li><strong>Dificuldade</strong> — quanto aquele conteúdo resiste a ser fixado (1–10);</li>
          <li><strong>Lembrança</strong> — a chance estimada de você lembrar agora.</li>
        </ul>
        <p>Cada revisão é marcada no momento em que a lembrança cai até a retenção desejada. Acertar algo difícil de lembrar aumenta muito a estabilidade; errar reduz e o cartão volta em 10 minutos.</p>
        <p>A <strong>confiança</strong> marcada antes de ver a resposta alimenta a calibração metacognitiva: se você diz “certeza” e erra, isso aparece como <em>ilusão de competência</em> no painel.</p>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Arquivos e backup</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:14px">
        <div>Notas (Markdown, abre no Obsidian ou qualquer editor):<div class="path">${esc(paths.vaultDir)}</div></div>
        <div>Banco de dados (agendamento e histórico):<div class="path">${esc(paths.dbPath)}</div></div>
        <div class="row" style="margin-top:6px">
          <button class="btn" data-open-vault>Abrir pasta das notas</button>
          <button class="btn" data-export>Exportar backup (.json)</button>
          <label class="btn" style="flex-direction:row;font-size:14px;color:var(--text)">Restaurar backup<input type="file" accept=".json,application/json" hidden data-import></label>
        </div>
        <small>Para mudar a pasta das notas, edite <span class="path">${esc(paths.dataDir)}\\config.json</span> e reabra o app.</small>
      </div>
    </section>
  </div>`));

  let timer;
  view.addEventListener('input', (e) => {
    const f = FIELDS.find((x) => x.key === e.target.name);
    if (!f) return;
    const value = f.list ? f.list[Number(e.target.value)] : Number(e.target.value);
    $(`[data-out=${f.key}]`, view).textContent = f.fmt(value);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await api('/api/settings', { method: 'PUT', body: { [f.key]: value } }); toast('Ajuste salvo.'); }
      catch (err) { toast(err.message, 'error'); }
    }, 400);
  });

  $('[data-open-vault]', view).addEventListener('click', () => api('/api/vault/open', { method: 'POST', body: {} }));
  $('[data-export]', view).addEventListener('click', async () => {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h(`<a download="memopara-backup-${new Date().toISOString().slice(0, 10)}.json"></a>`);
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('[data-import]', view).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!(await confirmDialog('Restaurar este backup? Todas as notas, cartões e histórico atuais serão substituídos.', { ok: 'Restaurar', danger: true }))) return;
    try {
      const r = await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
      toast(`Backup restaurado: ${r.notes} notas.`, 'good');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function nearest(list, v) {
  return list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}
