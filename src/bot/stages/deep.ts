// `deep`: the researcher reads the web about the role, then the advisor sets that against the masked profile. The
// researcher never sees the profile; the advisor gets the research only as an untrusted block, and its answer is posted,
// never passed to another model.
import { z } from 'zod';
import type { Handler } from '../handlers.ts';
import { advisorMessages } from '../prompt.ts';
import { TIMEOUT_REPLY, callStage, oneLine, stageErrorReply } from './call.ts';
import { botMaskingFor, isReply, loadJob, researchInputFor, stageOpts } from './handler.ts';
import {
  RESEARCH_TIMEOUT_MS, RESEARCH_UNAVAILABLE, renderResearch, researchErrorReply, researcherFor, runResearch, webFooter,
} from './researcher.ts';
import type { Research, ResearchResult } from './researcher.ts';

export const DeepSchema = z.object({
  fit: z.string().max(600),
  angle: z.string().max(600),
  risks: z.array(z.string().max(200)).max(5),
  questions: z.array(z.string().max(200)).max(6),
}).strict();
export type Deep = z.infer<typeof DeepSchema>;

/** Plain lines: replies are posted as plain text. */
export function renderDeep(v: Deep): string {
  const text = (heading: string, s: string) => (oneLine(s) ? [`${heading}:`, oneLine(s)] : []);
  const list = (heading: string, xs: string[]) => {
    const kept = xs.map(oneLine).filter(Boolean);
    return kept.length ? [`${heading}:`, ...kept.map((x) => `- ${x}`)] : [];
  };
  const parts = [text('How you match', v.fit), text('Angle to take', v.angle), list('Risks', v.risks), list('Questions to ask', v.questions)];
  return parts.filter((p) => p.length).map((p) => p.join('\n')).join('\n\n');
}

// finishReply cuts a reply past three comments, and escaping can make the text longer: with the advice at its longest,
// this keeps the footer in. The heading says "unverified" too, in case it is still cut.
const RESEARCH_CHARS_MAX = 4000;
const RESEARCH_HEADING = 'Research (from the web, unverified):';

function fitted(r: Research): { research: string; cited: Set<string> } {
  const points = [...r.points];
  let research = renderResearch(r);
  while (points.length > 1 && research.length > RESEARCH_CHARS_MAX) {
    points.pop();
    research = renderResearch({ ...r, points });
  }
  return { research, cited: new Set(points.map((p) => p.source)) };
}

export const jobDeepDive: Handler = async (ctx) => {
  const loaded = await loadJob(ctx, 'deep');
  if (isReply(loaded)) return loaded;
  const { job } = loaded;
  const o = stageOpts(ctx);
  const provider = researcherFor(o.llm);
  if (!provider) return { text: RESEARCH_UNAVAILABLE, uncounted: true };
  // Before the research, so a masking failure costs none.
  const masking = await botMaskingFor(ctx);
  if (isReply(masking)) return masking;
  const input = await researchInputFor(ctx, job, 'deep');
  if (isReply(input)) return input;

  let r: ResearchResult;
  try {
    r = await runResearch(input, {
      provider, signal: ctx.signal, log: ctx.log, timeoutMs: RESEARCH_TIMEOUT_MS,
      guard: { lookup: ctx.net.urlGuard?.lookup }, ...(o.call?.execImpl ? { exec: o.call.execImpl } : {}),
    });
  } catch (e) {
    return { text: researchErrorReply(e, ctx.log) };
  }
  if (ctx.signal.aborted) return { text: TIMEOUT_REPLY };

  const { research, cited } = fitted(r.research);
  const sources = r.sources.filter((u) => cited.has(u));
  try {
    const advice = await callStage(advisorMessages('deep', { job, research }, masking), DeepSchema, o);
    return { text: [renderDeep(advice.value), '', RESEARCH_HEADING, research, '', webFooter(sources)].join('\n'), links: sources };
  } catch (e) {
    return { text: stageErrorReply(e, ctx.log) };
  }
};
