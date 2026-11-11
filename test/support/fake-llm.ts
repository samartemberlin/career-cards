// An OpenAI-compatible endpoint stand-in that answers both the facts prompt and the scoring prompt.
import type { FetchJson } from '../../src/pipeline/llm.ts';
import type { ParsedFacts } from '../../src/pipeline/facts.ts';

export const fakeLlmEnv = { LLM_BASE_URL: 'http://llm.test/v1', LLM_API_KEY: 'test-key-0000', LLM_RPM: '0' };

const SCORING_SYSTEM = 'You score job postings';

function emptyFacts(key: string): ParsedFacts {
  return {
    key, posting_lang: 'en', title_en: null,
    german: { level: null, spoken_heavy: null, evidence: null },
    english_working_language: null,
    years: { min: null, max: null, evidence: null },
    degree_field: null, function: null, sector: null, seniority: null,
    driving_licence: null, unpaid_internship: null, methodology: [], deadline: null,
  };
}

const reply = (content: string) => ({
  ok: true, status: 200, text: async () => '',
  json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
});

/**
 * `score` decides each scoring reply: a number, `'quota'` (HTTP 429 with a daily-quota body) or `'bad'` (not JSON).
 * `facts` fills the facts reply; if it throws, the facts reply is not JSON, so that extraction fails.
 */
export function fakeLlm(o: {
  score: (key: string) => number | 'quota' | 'bad';
  facts?: (key: string) => Partial<ParsedFacts>;
}): { fetchImpl: FetchJson; requests: { system: string; user: string }[] } {
  const requests: { system: string; user: string }[] = [];
  const fetchImpl: FetchJson = async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    requests.push({ system, user });
    const key = /^key: (\S+)/m.exec(user)?.[1] ?? '';
    if (system.includes(SCORING_SYSTEM)) {
      const s = o.score(key);
      if (s === 'quota') {
        const body = '{"error":{"message":"Quota exceeded: requests per day"}}';
        return { ok: false, status: 429, text: async () => body, json: async () => JSON.parse(body) };
      }
      if (s === 'bad') return reply('not json');
      return reply(JSON.stringify({ key, score: s, reason: `fake reason for ${key}`, flags: [] }));
    }
    try {
      return reply(JSON.stringify({ ...emptyFacts(key), ...o.facts?.(key) }));
    } catch {
      return reply('not json');
    }
  };
  return { fetchImpl, requests };
}
