import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAi, splitIntoChunks, studyText, unverifiedNumbers, estimateTokens } from '../src/ai.js';

// LM Studio falso: responde /v1/models, /api/v0/models e /v1/chat/completions
function fakeLmStudio({ ctx = 8192, finals = [], maps = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/v1/models')) return json({ data: [{ id: 'qwen3-14b' }, { id: 'text-embedding-bge-m3' }] });
    if (url.includes('/api/v0/models/')) return json({ id: 'qwen3-14b', loaded_context_length: ctx });
    const body = JSON.parse(opts.body);
    calls.push(body);
    const isMap = body.response_format.json_schema.schema.properties.fatos;
    const content = isMap ? maps.shift() ?? { fatos: ['fato'], flashcards: [], avisos: [] } : finals.shift();
    return json({ choices: [{ message: { content: `<think></think>${JSON.stringify(content)}` }, finish_reason: 'stop' }] });
  };
  return { fetchImpl, calls };
}

const final = (cards, extra = {}) => ({ titulo: 'T', resumo: '### Tema\n- ponto', pontos_chave: ['p1'], flashcards: cards, avisos: [], ...extra });
const longText = Array.from({ length: 20 }, (_, i) => `### Página ${i + 1}\n\n${'Texto de estudo sobre sinapses e potenciais de ação. '.repeat(40)}`).join('\n\n');

test('short text goes in one pass; cards are cleaned, deduped and filtered against existing ones', async () => {
  const { fetchImpl, calls } = fakeLmStudio({
    finals: [final([
      { pergunta: 'Onde ocorre o ciclo de Krebs?', resposta: 'Na matriz\nmitocondrial.' },
      { pergunta: 'onde ocorre o  ciclo de krebs?', resposta: 'repetido' },
      { pergunta: 'Pigmento :: principal?', resposta: 'Clorofila' },
      { pergunta: 'Qual a dose?', resposta: '' },
      { pergunta: 'Já existe?', resposta: 'sim' }
    ])]
  });
  const ai = createAi({ fetchImpl });
  const r = await ai.suggest({ text: 'O ciclo de Krebs ocorre na matriz mitocondrial e produz NADH, FADH2 e GTP a cada volta.', existingCards: ['Já existe? :: sim'] });
  assert.equal(r.mode, 'uma passagem');
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /^\/no_think/);
  assert.deepEqual(r.flashcards.map((c) => [c.pergunta, c.resposta]), [
    ['Onde ocorre o ciclo de Krebs?', 'Na matriz mitocondrial.'],
    ['Pigmento: principal?', 'Clorofila']
  ]);
});

test('long text switches to page-by-page automatically and merges warnings', async () => {
  const { fetchImpl, calls } = fakeLmStudio({
    ctx: 8192,
    maps: [{ fatos: ['a'], flashcards: [{ pergunta: 'Da parte 1?', resposta: 'Sim' }], avisos: ['trecho ilegível na página 2'] }],
    finals: [final([{ pergunta: 'P?', resposta: 'R' }])]
  });
  const ai = createAi({ fetchImpl });
  const progress = [];
  const r = await ai.suggest({ text: longText }, { onProgress: (p) => progress.push(p.label) });
  assert.equal(r.mode, 'página a página');
  assert.ok(r.parts > 1);
  assert.equal(calls.length, r.parts + 1, 'uma chamada por parte + a junção final');
  assert.ok(calls.every((c) => estimateTokens(JSON.stringify(c.messages)) < 8192));
  assert.ok(r.avisos.includes('trecho ilegível na página 2'));
  assert.equal(progress.at(-1), 'Juntando tudo no resumo final');
  assert.deepEqual(r.flashcards.map((c) => c.pergunta), ['Da parte 1?', 'P?'], 'cartões das partes vêm antes dos do resumo final');
});

test('a bigger loaded context lets the same text go in one pass', async () => {
  const { fetchImpl } = fakeLmStudio({ ctx: 32768, finals: [final([{ pergunta: 'P?', resposta: 'R' }])] });
  assert.equal((await createAi({ fetchImpl }).suggest({ text: longText })).mode, 'uma passagem');
});

test('numbers/units not present in the source are flagged (silent OCR corrections)', async () => {
  assert.deepEqual(unverifiedNumbers('Dose de 3,5 mg/kg a cada 8 h; repouso -70 mV; 2 tipos', 'dose usual de 3,5 ma/kg às 14h, repetida a cada 8 h. repouso -70 mV'), ['3,5 mg/kg']);
  const { fetchImpl } = fakeLmStudio({ finals: [final([{ pergunta: 'Qual a dose do fármaco X?', resposta: '3,5 mg/kg' }])] });
  const r = await createAi({ fetchImpl }).suggest({ text: 'A dose usual do fármaco X é de 3,5 ma/kg às 14h, repetida a cada 8 h, segundo a aula de farmacologia.' });
  assert.deepEqual(r.flashcards[0].conferir, ['3,5 mg/kg']);
  assert.ok(r.avisos.some((a) => a.includes('3,5 mg/kg')));
});

test('jobs report progress, results and LM Studio being offline', async () => {
  const { fetchImpl } = fakeLmStudio({ finals: [final([{ pergunta: 'P?', resposta: 'R' }])] });
  const ai = createAi({ fetchImpl });
  const job = ai.startJob({ text: 'x'.repeat(200) });
  assert.equal(job.status, 'running');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ai.getJob(job.id).status, 'done');

  const offline = createAi({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await offline.status()).reachable, false);
  const j2 = offline.startJob({ text: 'y'.repeat(200) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(offline.getJob(j2.id).status, 'error');
  assert.match(offline.getJob(j2.id).error, /LM Studio/);
});

test('studyText drops template placeholders and the PDF link line', () => {
  const body = '# T\n\n📄 [Abrir o PDF original](a.pdf) · 2 páginas\n\n## Resumo\n\nEscreva com suas palavras as ideias principais.\n\n## Flashcards\n\nPergunta :: Resposta\n\n## Conteúdo\n\n​# texto';
  assert.equal(studyText(body), '# T\n\n## Resumo\n\n## Flashcards\n\n## Conteúdo\n\n# texto');
});

test('splitIntoChunks respects page boundaries and the size limit', () => {
  const chunks = splitIntoChunks(longText, 6000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 6000));
  assert.ok(chunks.every((c) => c.startsWith('### Página')));
  assert.deepEqual(splitIntoChunks('a'.repeat(15000), 6000).map((c) => c.length), [6000, 6000, 3000]);
});

test('insertSuggestions fills the template sections and keeps what the user wrote', async () => {
  const { insertSuggestions } = await import('../public/js/ai.js');
  const template = '# Aula\n\n📄 [Abrir o PDF original](a.pdf) · 2 páginas\n\n## Resumo\n\nEscreva com suas palavras as ideias principais.\n\n## Flashcards\n\nPergunta :: Resposta\n\n## Conteúdo do PDF\n\n### Página 1\n\ntexto';
  const out = insertSuggestions(template, { summary: '## Tema\n- ponto A', cards: [{ pergunta: 'P1?', resposta: 'R1' }, { pergunta: 'P2?', resposta: 'R2' }] });
  assert.equal(out, '# Aula\n\n📄 [Abrir o PDF original](a.pdf) · 2 páginas\n\n## Resumo\n\n### Tema\n- ponto A\n\n## Flashcards\n\nP1? :: R1\nP2? :: R2\n\n## Conteúdo do PDF\n\n### Página 1\n\ntexto\n');

  // resumo e cartões que o usuário já escreveu são mantidos; os novos vão depois
  const mine = '# N\n\n## Resumo\n\nMeu resumo.\n\n## Flashcards\n\nMinha? :: Sim\n';
  const out2 = insertSuggestions(mine, { summary: 'Novo', cards: [{ pergunta: 'Nova?', resposta: 'Ok' }] });
  assert.equal(out2, '# N\n\n## Resumo\n\nMeu resumo.\n\nNovo\n\n## Flashcards\n\nMinha? :: Sim\nNova? :: Ok\n');

  // nota sem seções: cria as duas
  const out3 = insertSuggestions('# Solta\n\nTexto livre.', { summary: 'S', cards: [{ pergunta: 'Q?', resposta: 'A' }] });
  assert.equal(out3, '# Solta\n\nTexto livre.\n\n## Resumo\n\nS\n\n## Flashcards\n\nQ? :: A\n');
});

test('empty "no problem" warnings from the model are dropped', async () => {
  const { fetchImpl } = fakeLmStudio({ finals: [final([{ pergunta: 'P?', resposta: 'R' }], { avisos: [
    "A frase 'X' não apresenta dúvidas.", "O trecho 'Y' parece estar completo e legível.",
    'Nenhum outro trecho do texto apresenta problemas.', "Trecho 'ma/kg' parece erro de OCR."
  ] })] });
  const r = await createAi({ fetchImpl }).suggest({ text: 'Texto de estudo suficientemente longo para gerar sugestões de revisão espaçada, com mais de oitenta caracteres.' });
  assert.deepEqual(r.avisos, ["Trecho 'ma/kg' parece erro de OCR."]);
});

test('near-duplicate cards (same idea, other words) are merged', async () => {
  const { isNearDuplicate } = await import('../src/ai.js');
  const a = { pergunta: 'O que são sinapses?', resposta: 'Regiões de comunicação entre neurônios ou entre um neurônio e uma célula efetora.' };
  const b = { pergunta: 'O que é uma sinapse?', resposta: 'É a região de comunicação entre dois neurônios ou entre um neurônio e uma célula efetora.' };
  const c = { pergunta: 'Qual é o potencial de repouso típico de um neurônio?', resposta: 'Cerca de -70 mV.' };
  const d = { pergunta: 'Qual neurotransmissor é excitatório no sistema nervoso central?', resposta: 'O glutamato é o principal neurotransmissor excitatório.' };
  const e = { pergunta: 'Qual neurotransmissor é inibitório no sistema nervoso central?', resposta: 'O GABA é o principal neurotransmissor inibitório.' };
  assert.equal(isNearDuplicate(b, [a]), true);
  assert.equal(isNearDuplicate(c, [a]), false);
  assert.equal(isNearDuplicate(e, [d]), false, 'excitatório vs inibitório são cartões diferentes');
});

test('cards with content not found in the source are flagged as possibly invented', async () => {
  const source = Array.from({ length: 12 }, (_, i) => `Texto de exemplo da linha ${i + 1} sobre enzimas.`).join('\n');
  const { fetchImpl } = fakeLmStudio({ finals: [final([
    { pergunta: 'O que é o sítio ativo de uma enzima?', resposta: 'Local específico onde o substrato se liga à enzima.' },
    { pergunta: 'Sobre o que é o texto de exemplo?', resposta: 'Sobre enzimas.' }
  ])] });
  const r = await createAi({ fetchImpl }).suggest({ text: source });
  assert.deepEqual(r.flashcards.map((c) => c.foraDoTexto), [true, false]);
  assert.ok(r.avisos.some((a) => /não está no texto/.test(a)));
});

test('a cut-off answer is retried lean, then skipped with a warning, and never fails the whole apostila', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let finalCalls = 0;
  const partAttempts = new Map();
  const fetchImpl = async (url, opts = {}) => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/v1/models')) return json({ data: [{ id: 'qwen3-14b' }] });
    if (url.includes('/api/v0/models/')) return json({ loaded_context_length: 8192 });
    const body = JSON.parse(opts.body);
    const user = body.messages[1].content;
    const reply = (content, finish = 'stop') => json({ choices: [{ message: { content }, finish_reason: finish }] });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (body.response_format.json_schema.schema.properties.fatos) {
      const part = Number(user.match(/Trecho (\d+) de/)[1]);
      const n = (partAttempts.get(part) || 0) + 1;
      partAttempts.set(part, n);
      if (part === 2 && n === 1) return reply('{"fatos": ["corta', 'length');      // estoura 1x, depois ok
      if (part === 3) return reply('{"fatos": ["tabela 1,2 3,4', 'length');        // sempre estoura
      const lean = !body.response_format.json_schema.schema.properties.flashcards;
      return reply(JSON.stringify(lean ? { fatos: [`fato enxuto ${part}`] } : { fatos: [`fato ${part}`], flashcards: [{ pergunta: `Pergunta da parte ${part}?`, resposta: `resposta ${part}` }], avisos: [] }));
    }
    finalCalls++;
    if (finalCalls === 1) return reply('{"titulo": "T", "resumo": "muito longo', 'length');
    return reply(JSON.stringify({ titulo: 'T', resumo: '### R', pontos_chave: [], flashcards: [], avisos: [] }));
  };
  const r = await createAi({ fetchImpl }).suggest({ text: longText });
  assert.equal(r.mode, 'página a página');
  assert.equal(partAttempts.get(2), 2, 'parte 2: uma nova tentativa enxuta');
  assert.equal(partAttempts.get(3), 2, 'parte 3: tentou de novo e depois desistiu só dela');
  assert.ok(r.avisos.some((a) => /parte 3 não pôde ser lida/i.test(a)));
  assert.equal(finalCalls, 2, 'resumo final refeito de forma mais concisa');
  assert.ok(r.flashcards.some((c) => c.pergunta === 'Pergunta da parte 1?'));
  assert.ok(!r.flashcards.some((c) => /parte 2\?|parte 3\?/.test(c.pergunta)), 'partes refeitas no modo enxuto não trazem cartões');
  assert.ok(maxInFlight >= 2 && maxInFlight <= 3, `partes em paralelo (máx. 3), visto: ${maxInFlight}`);
});
