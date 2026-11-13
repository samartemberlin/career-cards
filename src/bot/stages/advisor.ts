// The advisor stage: the job card against the masked rubric and CV, with no tools and no network.
import { z } from 'zod';
import type { CommandCtx, Handler, HandlerResult } from '../handlers.ts';
import { advisorMessages } from '../prompt.ts';
import { callStage, oneLine, stageErrorReply } from './call.ts';
import { isReply, loadJob, stageOpts, withMasking } from './handler.ts';

const items = (n: number, chars: number) => z.array(z.string().max(chars)).max(n);

export const FitSchema = z.object({
  summary: z.string().max(600),
  strengths: items(6, 200),
  gaps: items(6, 200),
  dealbreakers: items(4, 200),
}).strict();
export type Fit = z.infer<typeof FitSchema>;

export const CvSchema = z.object({
  lead_with: items(5, 200),
  mirror_terms: items(12, 60),
  gaps_to_address: items(5, 200),
  notes: z.string().max(600),
}).strict();
export type Cv = z.infer<typeof CvSchema>;

function section(heading: string, list: string[]): string[] {
  const kept = list.map(oneLine).filter(Boolean);
  return kept.length ? ['', `${heading}:`, ...kept.map((s) => `- ${s}`)] : [];
}

// Plain lines: replies are posted as plain text (finishReply escapes Markdown).
export function renderFit(v: Fit, score: number | null): string {
  const summary = oneLine(v.summary);
  const head = score === null ? summary : `Scored ${score}/10. ${summary}`.trim();
  const lines = [head, ...section('Strong points', v.strengths), ...section('Gaps', v.gaps), ...section('Deal-breakers', v.dealbreakers)];
  return (lines[0] ? lines : lines.slice(2)).join('\n') || 'No fit explanation for this job.';
}

export function renderCv(v: Cv): string {
  const terms = v.mirror_terms.map(oneLine).filter(Boolean);
  const notes = oneLine(v.notes);
  const lines = [
    ...section('Lead with', v.lead_with),
    ...(terms.length ? ['', `Terms from the posting to mirror: ${terms.join(', ')}`] : []),
    ...section('Gaps to address', v.gaps_to_address),
    ...(notes ? ['', notes] : []),
  ];
  return lines.length ? lines.slice(1).join('\n') : 'No CV suggestions for this job.';
}

async function advisorStage(ctx: CommandCtx, kind: 'fit' | 'cv'): Promise<HandlerResult> {
  const loaded = await loadJob(ctx, kind);
  if (isReply(loaded)) return loaded;
  const { job } = loaded;
  const messages = await withMasking(ctx, (m) => advisorMessages(kind, { job }, m));
  if (isReply(messages)) return messages;

  const o = stageOpts(ctx);
  try {
    if (kind === 'fit') return { text: renderFit((await callStage(messages, FitSchema, o)).value, job.score) };
    return { text: renderCv((await callStage(messages, CvSchema, o)).value) };
  } catch (e) {
    return { text: stageErrorReply(e, ctx.log) };
  }
}

export const explainFit: Handler = (ctx) => advisorStage(ctx, 'fit');
export const cvTips: Handler = (ctx) => advisorStage(ctx, 'cv');
