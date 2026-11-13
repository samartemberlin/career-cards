// `company [topic]`: for `openings`, the company's own careers board read by career-ops when it can find one (no
// model); otherwise, and for every other topic, the researcher.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { z } from 'zod';
import { careerOpsEnv } from '../../pipeline/career-ops-env.ts';
import type { ParentEnv } from '../../pipeline/career-ops-env.ts';
import { jobKey } from '../../pipeline/keys.ts';
import { runCareerOpsScan } from '../../run/scan.ts';
import type { COMPANY_TOPICS } from '../catalogue.ts';
import type { Handler, HandlerResult } from '../handlers.ts';
import { oneLine } from './call.ts';
import { isReply, loadJob, researchInputFor, stageOpts } from './handler.ts';
import {
  RESEARCH_TIMEOUT_MS, RESEARCH_UNAVAILABLE, renderResearch, researchErrorReply, researcherFor, runResearch, sourceUrl, webFooter,
} from './researcher.ts';

export type Openings = { careersUrl: string; jobs: { title: string; url: string; location: string }[] };

const DISCOVER_TIMEOUT_MS = 45_000;
const SCAN_TIMEOUT_MS = 60_000;
const OPENINGS_MAX = 25;
// LINKS_MAX is 10: nine jobs and the careers board.
const SHOWN_MAX = 9;
// Under the 300 s comment timeout, with room to post the reply.
const HANDLER_BUDGET_MS = 270_000;
const TMP_PREFIX = 'career-cards-discover-';

const Resolved = z.object({ name: z.string(), careers_url: z.string().url(), api: z.string().url().optional() });

function runDiscover(cwd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => {
      if (e) reject(new Error(`discover-ats failed: ${e.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e.message.split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

/**
 * The company's open roles from its ATS board, or null when career-ops finds no board. The name reaches
 * discover-ats only inside a temp YAML file, never on argv, and no `--write`: it probes and prints, writing nothing.
 */
export async function findOpenings(company: string, o: {
  careerOpsDir: string; env: ParentEnv; exclude: string; timeoutMs?: number; deadline?: number;
}): Promise<Openings | null> {
  const timeoutMs = Math.min(o.timeoutMs ?? DISCOVER_TIMEOUT_MS, (o.deadline ?? Infinity) - Date.now());
  if (timeoutMs <= 0) throw new Error('openings not looked up: no time left');
  const tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  let stdout: string;
  try {
    const companies = join(tmp, 'companies.yml');
    const portals = join(tmp, 'portals.yml');
    writeFileSync(companies, dumpYaml({ companies: [{ name: company }] }));
    writeFileSync(portals, dumpYaml({ tracked_companies: [] }));
    const env = careerOpsEnv(o.env, { CAREER_OPS_PORTALS: portals });
    stdout = await runDiscover(o.careerOpsDir, ['discover-ats.mjs', '--in', companies], env, timeoutMs);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const out = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { resolved?: unknown[] };
  if (!out.resolved?.length) return null;
  const board = Resolved.parse(out.resolved[0]);
  const rows = await runCareerOpsScan(
    { tracked_companies: [{ name: board.name, careers_url: board.careers_url, ...(board.api ? { api: board.api } : {}), enabled: true }] },
    { careerOpsDir: o.careerOpsDir, env: o.env, timeoutMs: SCAN_TIMEOUT_MS, ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) },
  );
  // An empty board with errors is a failed read, not "no openings".
  if (!rows.length && rows.errors.length) throw new Error(`openings scan failed: ${rows.errors[0]!.error}`);
  const jobs = rows
    .filter((r) => r.url && jobKey(r.url) !== o.exclude)
    .sort((a, b) => (b.posted ?? '').localeCompare(a.posted ?? ''))
    .slice(0, OPENINGS_MAX)
    .map((r) => ({ title: r.title, url: r.url, location: r.location ?? '' }));
  return { careersUrl: board.careers_url, jobs };
}

/** Plain lines; a job link the reply couldn't list exactly is left out, the job still shown. */
export function renderOpenings(company: string, o: Openings): string {
  const name = oneLine(company);
  const board = sourceUrl(o.careersUrl);
  if (!o.jobs.length) return `No other open roles at ${name} on its careers board right now${board ? `: ${board}` : '.'}`;
  const lines = [`Open roles at ${name} (from its careers board, read just now):`];
  for (const j of o.jobs.slice(0, SHOWN_MAX)) {
    const head = [oneLine(j.title) || '(untitled)', oneLine(j.location)].filter(Boolean).join(' · ');
    const url = sourceUrl(j.url);
    lines.push(url ? `- ${head}: ${url}` : `- ${head}`);
  }
  const more = o.jobs.length - SHOWN_MAX;
  if (more > 0) lines.push(`…and ${more} more${board ? `: ${board}` : '.'}`);
  return lines.join('\n');
}

function openingsReply(company: string, o: Openings): HandlerResult {
  const links = [...o.jobs.slice(0, SHOWN_MAX).map((j) => j.url), o.careersUrl].map(sourceUrl).filter((u): u is string => u !== null);
  return { text: renderOpenings(company, o), links };
}

const firstLine = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split('\n')[0];

export const companyResearch: Handler = async (ctx, args) => {
  const started = Date.now();
  const loaded = await loadJob(ctx, 'company');
  if (isReply(loaded)) return loaded;
  const { topic } = args as { topic: (typeof COMPANY_TOPICS)[number] };
  // Before the openings lookup too: the company name goes to the ATS hosts as well.
  const input = await researchInputFor(ctx, loaded.job, topic);
  if (isReply(input)) return input;

  if (topic === 'openings' && ctx.net.openings) {
    try {
      const found = await ctx.net.openings(input.company, loaded.job.key);
      if (found) return openingsReply(input.company, found);
      ctx.log(`company openings: no careers board found on ${ctx.action.id}`);
    } catch (e) {
      ctx.log(`company openings failed on ${ctx.action.id}: ${firstLine(e)}`);
    }
  }

  const o = stageOpts(ctx);
  const provider = researcherFor(o.llm);
  if (!provider) return { text: RESEARCH_UNAVAILABLE, uncounted: true };
  try {
    const r = await runResearch(input, {
      provider, signal: ctx.signal, log: ctx.log,
      guard: { lookup: ctx.net.urlGuard?.lookup },
      exec: o.call?.execImpl,
      timeoutMs: Math.min(RESEARCH_TIMEOUT_MS, HANDLER_BUDGET_MS - (Date.now() - started)),
    });
    return { text: `${renderResearch(r.research)}\n\n${webFooter(r.sources)}`, links: r.sources };
  } catch (e) {
    return { text: researchErrorReply(e, ctx.log) };
  }
};
