// What the researcher may know about a job: four fields, never the description, the profile or any comment.
// Kept apart from researcher.ts so prompt.ts can check the brand without importing the stage.
import { COMPANY_TOPICS } from '../catalogue.ts';
import type { JobFields } from '../context.ts';
import { SAFE_LINK } from '../reply.ts';

export const RESEARCH_TOPICS = [...COMPANY_TOPICS, 'deep'] as const;
export type ResearchTopic = (typeof RESEARCH_TOPICS)[number];
export type ResearchInput = Readonly<{ company: string; title: string; postingUrl: string; topic: ResearchTopic }>;

const FIELD_MAX = 120;
const URL_MAX = 500;

const field = (s: string): string =>
  [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()].slice(0, FIELD_MAX).join('').trim();

function postingUrl(u: string): string {
  const s = u.trim();
  if (s.length > URL_MAX || !SAFE_LINK.test(s)) return '';
  try {
    const p = new URL(s).protocol;
    return p === 'http:' || p === 'https:' ? s : '';
  } catch {
    return '';
  }
}

// A spread copy passes the type check with extra fields, so prompt.ts checks this brand at run time.
const built = new WeakSet<object>();

export function researchInputFromJob(job: JobFields, topic: ResearchTopic): ResearchInput {
  if (!RESEARCH_TOPICS.includes(topic)) throw new Error(`unknown research topic: ${String(topic)}`);
  const input = Object.freeze({ company: field(job.company), title: field(job.title), postingUrl: postingUrl(job.url), topic });
  built.add(input);
  return input;
}

export function isResearchInput(x: unknown): x is ResearchInput {
  return typeof x === 'object' && x !== null && built.has(x);
}
