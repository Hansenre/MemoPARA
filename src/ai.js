// Sugestões de resumo e flashcards com um modelo local do LM Studio (API compatível com OpenAI).
// Nada é gravado aqui: o resultado volta para a tela de revisão, onde o usuário escolhe o que inserir.
import crypto from 'node:crypto';
import { httpError } from './vault.js';

export const AI_DEFAULTS = {
  baseUrl: process.env.MEMOPARA_LLM_URL || 'http://localhost:1234',
  model: process.env.MEMOPARA_AI_MODEL || 'qwen3-14b'
};
const CHARS_PER_TOKEN = 3.5;      // português medido no qwen3: ~3,8 caracteres/token (margem de segurança)
const FINAL_OUTPUT_TOKENS = 3500;
// medido na apostila de 36 páginas: partes usam 300–880 tokens; 1500 dá folga (900 estourava às vezes)
const MAP_OUTPUT_TOKENS = 1500;
const MAP_CONCURRENCY = 3;        // o LM Studio atende pedidos em paralelo (slots); 3 partes por vez
const PROMPT_OVERHEAD = 700;
const CHUNK_CHARS = 6000;         // tamanho de cada parte no modo página a página
const MAX_CARDS = 25;

const SYSTEM = `Você é um assistente de estudo. Responda em português do Brasil e somente com o JSON pedido.
Use apenas informações do texto; não invente nem complete com conhecimento próprio. Se o texto tiver pouco conteúdo de estudo, gere poucos cartões (ou nenhum) em vez de completar.
Se algum trecho parecer errado, ilegível ou com erro de OCR (letras trocadas, unidades estranhas), NÃO corrija em silêncio: copie o trecho original em "avisos" explicando a dúvida.`;

const FINAL_INSTRUCTIONS = `Produza:
- "titulo": título curto do conteúdo;
- "resumo": resumo de estudo em Markdown, organizado por temas com subtítulos "###" e tópicos "-";
- "pontos_chave": até 10 frases curtas com o essencial;
- "flashcards": de 5 a 15 cartões para revisão espaçada. Regras: uma única ideia por cartão; nada de perguntas de lista ("quais são as etapas…"); a resposta deve responder exatamente à pergunta, com no máximo 15 palavras; não repita cartões já existentes;
- "avisos": SOMENTE problemas reais — trechos que parecem errados ou ilegíveis e números/unidades suspeitos, citando o trecho. Não escreva avisos do tipo "não há dúvidas"; se não houver problema, devolva lista vazia.`;

const LONG_MATERIAL = `Este material é longo e foi lido em partes. Cubra TODOS os temas das partes de forma equilibrada (não se concentre só no primeiro tema): o resumo deve ter um "###" para cada tema, e gere de 12 a 15 flashcards distribuídos entre os temas.`;

// avisos vazios que o modelo às vezes escreve ("…não apresenta dúvidas", "parece correto")
const NO_ISSUE = /(não|nao)\s+(apresenta|há|ha|tem|possui)(\s+nenhuma?)?\s+(dúvida|duvida|problema|erro)|sem\s+(dúvidas|duvidas|problemas)|parece\s+(estar\s+)?(correto|completo)|nenhum\s+outro\s+trecho/i;

// maxLength limita cada texto na própria gramática do modelo: um aviso não consegue mais
// copiar uma tabela inteira de números (era o que enchia a resposta nas páginas de tabela)
const str = (max) => ({ type: 'string', maxLength: max });
const cardSchema = (maxItems) => ({
  type: 'array', maxItems,
  items: { type: 'object', properties: { pergunta: str(200), resposta: str(200) }, required: ['pergunta', 'resposta'] }
});

const finalSchema = (maxCards = 15) => ({
  type: 'object',
  properties: {
    titulo: str(120),
    resumo: str(6000),
    pontos_chave: { type: 'array', items: str(250), maxItems: 10 },
    flashcards: cardSchema(maxCards),
    avisos: { type: 'array', items: str(220), maxItems: 8 }
  },
  required: ['titulo', 'resumo', 'pontos_chave', 'flashcards', 'avisos']
});

const mapSchema = {
  type: 'object',
  properties: {
    fatos: { type: 'array', items: str(250), maxItems: 10 },
    flashcards: cardSchema(4),
    avisos: { type: 'array', items: str(200), maxItems: 3 }
  },
  required: ['fatos', 'flashcards', 'avisos']
};

// pedido enxuto para a segunda tentativa de uma parte que estourou o limite
const leanMapSchema = {
  type: 'object',
  properties: { fatos: { type: 'array', items: str(200), maxItems: 6 } },
  required: ['fatos']
};

const LENGTH = 'length';

export const estimateTokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN);

// Separa o texto em partes: por "### Página N" (PDFs/apostilas) e, se preciso, por parágrafos.
export function splitIntoChunks(text, maxChars = CHUNK_CHARS) {
  const pages = String(text).split(/\n(?=###\s+Página\s+\d+)/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  for (const page of pages) {
    if (page.length <= maxChars) { pieces.push(page); continue; }
    let buf = '';
    for (const para of page.split(/\n{2,}/)) {
      if (buf && buf.length + para.length + 2 > maxChars) { pieces.push(buf); buf = ''; }
      // parágrafo gigante (OCR sem quebras): corta no tamanho máximo
      for (let i = 0; i < para.length; i += maxChars) {
        const part = para.slice(i, i + maxChars);
        if (buf && buf.length + part.length + 2 > maxChars) { pieces.push(buf); buf = ''; }
        buf = buf ? `${buf}\n\n${part}` : part;
      }
    }
    if (buf) pieces.push(buf);
  }
  // junta páginas pequenas vizinhas para fazer menos chamadas ao modelo
  const chunks = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + p.length + 2 <= maxChars) chunks[chunks.length - 1] = `${last}\n\n${p}`;
    else chunks.push(p);
  }
  return chunks;
}

// Texto que vai para o modelo: a nota sem o modelo de resumo/flashcards vazio e sem o link do PDF.
export function studyText(body) {
  return String(body ?? '')
    .replace(/^📄 \[[^\]]*\]\([^)]*\).*$/m, '')
    .replace(/^Escreva com suas palavras.*$/gm, '')
    .replace(/^Pergunta :: Resposta\s*$/gm, '')
    .replace(/​/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const normalize = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');

// Números com unidade que aparecem na sugestão mas não no texto original (ex.: OCR "ma/kg" virando "mg/kg").
export function unverifiedNumbers(output, source) {
  const src = normalize(source);
  const found = new Set();
  // número + unidade conhecida (doses, medidas, tempo); palavras comuns depois do número não contam
  const unit = '(?:%|(?:mc|µ|μ|m|n|k)?(?:g|l|mol|eq|v|m|s)(?:\\/(?:kg|m2|m²|dia|h|min|l|dl|ml))?|ui|mmhg|h|min|dias?|anos?|°c)';
  const re = new RegExp(`\\d+(?:[.,]\\d+)*(?:\\s*${unit}(?![\\p{L}\\d]))?`, 'giu');
  for (const m of String(output).matchAll(re)) {
    const token = m[0].trim();
    if (/^\d$/.test(token)) continue; // "2 tipos" costuma estar escrito por extenso no original
    if (!src.includes(normalize(token))) found.add(token);
  }
  return [...found];
}

// Palavras de conteúdo (sem acento, sem plural simples e sem palavras vazias) para comparar cartões.
const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(plain('a o as os um uma uns umas de da do das dos e é ou em no na nos nas por para com que qual quais como onde quando quem são é ser se ao aos à às entre sobre seu sua seus suas dois duas cerca'.split(' ').join(' ')).split(' '));
const words = (s) => new Set(plain(s).match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && w.length > 1)
  .map((w) => w.replace(/oes$/, 'ao').replace(/(aes|ais|eis|s)$/, '')) ?? []);

// Cartões quase iguais (mesma pergunta com outras palavras): Jaccard das palavras de pergunta + resposta.
export function isNearDuplicate(card, kept, threshold = 0.6) {
  const a = words(`${card.pergunta} ${card.resposta}`);
  return kept.some((k) => {
    const b = words(`${k.pergunta} ${k.resposta}`);
    const inter = [...a].filter((w) => b.has(w)).length;
    return inter / (a.size + b.size - inter || 1) >= threshold;
  });
}

// Quanto da resposta (pergunta + resposta) aparece no texto original, comparando radicais de 5 letras.
// Baixo = o modelo provavelmente completou com conhecimento próprio (inventou).
const stems = (s) => new Set([...words(s)].map((w) => w.slice(0, 5)));
export function grounding(card, source) {
  const src = stems(source);
  const c = [...stems(`${card.pergunta} ${card.resposta}`)];
  if (c.length < 3) return 1;
  return c.filter((w) => src.has(w)).length / c.length;
}
const GROUNDING_MIN = 0.5; // medido: cartões inventados 0,11–0,25; cartões fiéis 0,63–1,00

function cleanCard(c) {
  const fix = (s) => String(s ?? '').replace(/\s*::\s*/g, ': ').replace(/\s+/g, ' ').trim();
  return { pergunta: fix(c.pergunta), resposta: fix(c.resposta) };
}

export function createAi({ fetchImpl = fetch, baseUrl = AI_DEFAULTS.baseUrl, model = AI_DEFAULTS.model, now = () => Date.now() } = {}) {
  const jobs = new Map();

  async function status() {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2500) });
      const models = (await res.json()).data?.map((m) => m.id) ?? [];
      return { available: models.includes(model), reachable: true, model, models: models.filter((m) => !/embed/i.test(m)), context: await contextLength() };
    } catch {
      return { available: false, reachable: false, model, models: [], context: null };
    }
  }

  // Tamanho de contexto com que o modelo está carregado (API REST do LM Studio); 8192 se não souber.
  async function contextLength() {
    try {
      const res = await fetchImpl(`${baseUrl}/api/v0/models/${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(2500) });
      const info = await res.json();
      return Number(info.loaded_context_length) || 8192;
    } catch {
      return 8192;
    }
  }

  async function chat(user, schema, maxTokens, signal) {
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: maxTokens,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `/no_think\n${user}` }],
        response_format: { type: 'json_schema', json_schema: { name: 'estudo', strict: true, schema } }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = JSON.stringify(data);
      if (/exceed|context/i.test(msg)) throw httpError(413, 'O texto ficou grande demais para o contexto do modelo.');
      throw httpError(502, `O LM Studio recusou o pedido (${res.status}).`);
    }
    const choice = data.choices?.[0];
    const raw = String(choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    try { return JSON.parse(raw); } catch {
      if (choice?.finish_reason === 'length') throw Object.assign(httpError(502, 'O modelo não terminou a resposta (limite de tamanho).'), { code: LENGTH });
      throw httpError(502, 'O modelo devolveu uma resposta inválida. Tente de novo.');
    }
  }

  const MAP_PROMPT = 'Liste os fatos essenciais deste trecho de material de estudo, em frases curtas e completas (até 10), de 2 a 4 flashcards sobre ESTE trecho (uma ideia por cartão, sem perguntas de lista, resposta de até 15 palavras) e, em "avisos", só trechos que pareçam realmente errados ou ilegíveis, em no máximo uma frase cada e sem copiar tabelas (lista vazia se não houver).';
  const LEAN_PROMPT = 'Liste apenas os fatos essenciais deste trecho de material de estudo, em até 6 frases curtas. Ignore tabelas de números.';

  // Lê uma parte; se a resposta estourar o limite (ex.: página só de tabela), tenta de novo com um
  // pedido enxuto e, se ainda assim falhar, segue sem essa parte em vez de perder a apostila inteira.
  async function readPart(chunk, i, total, signal) {
    const label = `Trecho ${i + 1} de ${total}:\n"""\n${chunk}\n"""`;
    try {
      return await chat(`${MAP_PROMPT}\n\n${label}`, mapSchema, MAP_OUTPUT_TOKENS, signal);
    } catch (err) {
      if (err.code !== LENGTH) throw err;
    }
    try {
      const r = await chat(`${LEAN_PROMPT}\n\n${label}`, leanMapSchema, MAP_OUTPUT_TOKENS, signal);
      return { fatos: r.fatos, flashcards: [], avisos: [] };
    } catch (err) {
      if (err.code !== LENGTH) throw err;
      return { fatos: [], flashcards: [], avisos: [`A parte ${i + 1} não pôde ser lida pela IA (texto muito denso, como tabelas). Confira essa parte no PDF.`] };
    }
  }

  // Executa até `limit` tarefas ao mesmo tempo, mantendo a ordem dos resultados.
  async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  // Resumo final; se estourar o limite, tenta de novo pedindo menos cartões.
  async function finalPass(prompt, signal) {
    try {
      return await chat(prompt, finalSchema(15), FINAL_OUTPUT_TOKENS, signal);
    } catch (err) {
      if (err.code !== LENGTH) throw err;
      return chat(`${prompt}\n\nSeja mais conciso: resumo curto e no máximo 8 flashcards.`, finalSchema(8), FINAL_OUTPUT_TOKENS, signal);
    }
  }

  async function suggest({ text, existingCards = [], title = '' }, { onProgress = () => {}, signal = new AbortController().signal } = {}) {
    const source = String(text ?? '').trim();
    if (source.length < 80) throw httpError(400, 'A nota tem pouco texto para gerar sugestões.');
    const ctx = await contextLength();
    const existing = existingCards.length ? `\n\nCartões que já existem (não repita):\n${existingCards.slice(0, 40).map((c) => `- ${c}`).join('\n')}` : '';
    const header = `${FINAL_INSTRUCTIONS}${title ? `\n\nTítulo da nota: ${title}` : ''}${existing}`;
    const fitsOnce = estimateTokens(source) + estimateTokens(header) + PROMPT_OVERHEAD + FINAL_OUTPUT_TOKENS <= ctx;
    const started = now();
    let result;
    let mode;
    let parts = 1;

    if (fitsOnce) {
      mode = 'uma passagem';
      onProgress({ step: 1, total: 1, label: 'Lendo o texto inteiro' });
      result = await finalPass(`${header}\n\nTexto:\n"""\n${source}\n"""`, signal);
    } else {
      mode = 'página a página';
      const chunks = splitIntoChunks(source, Math.min(CHUNK_CHARS, Math.floor((ctx - MAP_OUTPUT_TOKENS - PROMPT_OVERHEAD) * CHARS_PER_TOKEN)));
      parts = chunks.length;
      let done = 0;
      onProgress({ step: 0, total: chunks.length + 1, label: `Lendo ${chunks.length} partes (${MAP_CONCURRENCY} de cada vez)` });
      const read = await pool(chunks, MAP_CONCURRENCY, async (chunk, i) => {
        if (signal.aborted) throw httpError(499, 'Cancelado.');
        const r = await readPart(chunk, i, chunks.length, signal);
        done++;
        onProgress({ step: done, total: chunks.length + 1, label: `Partes lidas: ${done} de ${chunks.length}` });
        return r;
      });
      const notes = read.map((r, i) => `Parte ${i + 1}:\n- ${r.fatos.join('\n- ')}`);
      const warnings = read.flatMap((r) => r.avisos);
      const partCards = read.flatMap((r) => r.flashcards); // cartões de cada parte: garantem que todos os temas apareçam
      onProgress({ step: chunks.length + 1, total: chunks.length + 1, label: 'Juntando tudo no resumo final' });
      // se as anotações juntas ainda não couberem, corta proporcionalmente
      let joined = notes.join('\n\n');
      const budgetChars = (ctx - FINAL_OUTPUT_TOKENS - PROMPT_OVERHEAD - estimateTokens(header)) * CHARS_PER_TOKEN;
      if (joined.length > budgetChars) joined = joined.slice(0, Math.max(1000, budgetChars));
      result = await finalPass(`${header}\n\n${LONG_MATERIAL}\n\nUse estas anotações, extraídas parte a parte do material:\n"""\n${joined}\n"""`, signal);
      result.avisos = [...warnings, ...result.avisos];
      // primeiro os cartões das partes (na ordem do material), depois os do resumo final
      result.flashcards = [...partCards, ...result.flashcards];
    }

    const seen = new Set(existingCards.map((c) => normalize(c.split('::')[0])));
    const flashcards = result.flashcards.map(cleanCard)
      .filter((c) => c.pergunta && c.resposta && !seen.has(normalize(c.pergunta)) && seen.add(normalize(c.pergunta)))
      .reduce((kept, c) => (isNearDuplicate(c, kept) ? kept : [...kept, c]), [])
      .slice(0, MAX_CARDS)
      .map((c) => ({ ...c, conferir: unverifiedNumbers(`${c.pergunta} ${c.resposta}`, source), foraDoTexto: grounding(c, source) < GROUNDING_MIN }));
    const outputText = [result.resumo, ...result.pontos_chave].join('\n');
    const avisos = [...new Set(result.avisos.map((a) => String(a).trim()).filter((a) => a && !NO_ISSUE.test(a)))];
    const numbers = unverifiedNumbers(outputText + flashcards.map((c) => c.resposta).join(' '), source);
    if (numbers.length) avisos.push(`Números/unidades que não aparecem iguais no texto original — confira: ${numbers.join(', ')}`);
    const invented = flashcards.filter((c) => c.foraDoTexto).length;
    if (invented) avisos.push(`${invented} ${invented === 1 ? 'cartão traz' : 'cartões trazem'} informação que não está no texto (o modelo pode ter completado por conta própria). ${invented === 1 ? 'Ele veio desmarcado' : 'Eles vieram desmarcados'}.`);

    return {
      model, mode, parts, seconds: Math.round((now() - started) / 100) / 10,
      titulo: String(result.titulo || '').trim(),
      resumo: String(result.resumo || '').trim(),
      pontos_chave: result.pontos_chave.map((p) => String(p).trim()).filter(Boolean),
      flashcards, avisos
    };
  }

  // Trabalhos em segundo plano: a geração pode levar minutos, então o navegador acompanha por consulta.
  function startJob(input) {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id, status: 'running', progress: { step: 0, total: 1, label: 'Preparando' }, startedAt: now(), controller };
    jobs.set(id, job);
    suggest(input, { signal: controller.signal, onProgress: (p) => { job.progress = p; } })
      .then((result) => Object.assign(job, { status: 'done', result }))
      .catch((err) => Object.assign(job, {
        status: controller.signal.aborted ? 'cancelled' : 'error',
        error: err.status ? err.message : /fetch failed|ECONNREFUSED/i.test(String(err.cause ?? err.message)) ? 'Não consegui falar com o LM Studio. Ele está aberto com o servidor local ligado?' : err.message
      }))
      .finally(() => setTimeout(() => jobs.delete(id), 30 * 60_000).unref?.());
    return publicJob(job);
  }

  function getJob(id) {
    const job = jobs.get(String(id));
    if (!job) throw httpError(404, 'Tarefa não encontrada.');
    return publicJob(job);
  }

  function cancelJob(id) {
    const job = jobs.get(String(id));
    if (job && job.status === 'running') job.controller.abort();
    return { ok: true };
  }

  const publicJob = (j) => ({ id: j.id, status: j.status, progress: j.progress, elapsed: Math.round((now() - j.startedAt) / 1000), result: j.result, error: j.error });

  return { status, suggest, startJob, getJob, cancelJob };
}
