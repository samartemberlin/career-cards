// An OpenAI-compatible endpoint stand-in that answers the compile, facts and scoring prompts.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchJson } from '../../src/pipeline/llm.ts';
import type { ParsedFacts } from '../../src/pipeline/facts.ts';
import type { Compiled } from '../../src/compile/schema.ts';

export const fakeLlmEnv = { LLM_BASE_URL: 'http://llm.test/v1', LLM_API_KEY: 'test-key-0000', LLM_RPM: '0' };

const SCORING_SYSTEM = 'You score job postings';
const COMPILE_SYSTEM = "You turn a job seeker's own notes";

/** What the model would read from the sample Profiles board (tools/sample/profiles.ts); only "Content editor" is active. */
export const SAMPLE_COMPILED: Compiled = {
  places: { anywhere: false, keep: ['Berlin', 'Germany', 'EU'], drop: ['Munich', 'München'] },
  employment: { keep: ['full_time', 'part_time', 'contract', 'temporary'], remote_only: ['full_time'] },
  linkedin_locations: [{ location: 'Berlin' }, { location: 'Germany', remote: true }],
  company_exclude: ['Example Staffing GmbH'],
  text_exclude: ['unpaid'],
  languages: { de: { read: 'B2', write: 'B1', speak: 'B1' } },
  years_experience: 3,
  profiles: [{
    name: 'Content editor',
    search_terms: ['content editor', 'online editor', 'redakteur', 'content manager'],
    title_include: ['editor', 'redakteur', 'content manager'],
    title_exclude: ['senior', 'lead', 'head of'],
    examples: [
      { role: 'Content editor at a media company', score: 8 },
      { role: 'Online editor at a publisher', score: 7 },
      { role: 'Senior content manager at a large agency', score: 3 },
      { role: 'Marketing writer at a consulting firm', score: 2 },
    ],
  }],
  unused: [],
  problems: [],
};

/** The compile reply: an object (sent as JSON), `'quota'` or `'bad'` (not JSON). */
export type CompileReply = Compiled | 'quota' | 'bad';

function emptyFacts(key: string): ParsedFacts {
  return {
    key, posting_lang: 'en', title_en: null,
    german: { level: null, spoken_heavy: null, evidence: null },
    english_working_language: null, other_languages: [],
    years: { min: null, max: null, evidence: null },
    degree_field: null, function: null, sector: null, seniority: null,
    driving_licence: null, unpaid_internship: null, methodology: [], deadline: null,
  };
}

const reply = (content: string) => ({
  ok: true, status: 200, text: async () => '',
  json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
});

function quota() {
  const body = '{"error":{"message":"Quota exceeded: requests per day"}}';
  return { ok: false, status: 429, text: async () => body, json: async () => JSON.parse(body) };
}

/**
 * `score` decides each scoring reply: a number, `'quota'` (HTTP 429 with a daily-quota body) or `'bad'` (not JSON).
 * `facts` fills the facts reply, or `'quota'` answers it like `score`; if it throws, the facts reply is not JSON.
 */
export function fakeLlm(o: {
  score: (key: string) => number | 'quota' | 'bad';
  facts?: (key: string) => Partial<ParsedFacts> | 'quota';
  /** Default SAMPLE_COMPILED. */
  compile?: () => CompileReply;
}): { fetchImpl: FetchJson; requests: { system: string; user: string }[] } {
  const requests: { system: string; user: string }[] = [];
  const fetchImpl: FetchJson = async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    requests.push({ system, user });
    if (system.startsWith(COMPILE_SYSTEM)) {
      const c = o.compile?.() ?? SAMPLE_COMPILED;
      if (c === 'quota') return quota();
      return reply(c === 'bad' ? 'not json' : JSON.stringify(c));
    }
    const key = /^key: (\S+)/m.exec(user)?.[1] ?? '';
    if (system.includes(SCORING_SYSTEM)) {
      const s = o.score(key);
      if (s === 'quota') return quota();
      if (s === 'bad') return reply('not json');
      return reply(JSON.stringify({ key, score: s, reason: `fake reason for ${key}`, flags: [] }));
    }
    try {
      const f = o.facts?.(key);
      if (f === 'quota') return quota();
      return reply(JSON.stringify({ ...emptyFacts(key), ...f }));
    } catch {
      return reply('not json');
    }
  };
  return { fetchImpl, requests };
}

/** The same stand-in over HTTP, for code that takes its model from the environment: `env` points LLM_BASE_URL at it. */
export async function serveFakeLlm(llm: { fetchImpl: FetchJson }): Promise<{ env: typeof fakeLlmEnv; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      void llm.fetchImpl(`http://llm.test${req.url ?? ''}`, { method: 'POST', body }).then(async (r) => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.ok ? JSON.stringify(await r.json()) : await r.text());
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    env: { ...fakeLlmEnv, LLM_BASE_URL: `http://127.0.0.1:${port}/v1` },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
