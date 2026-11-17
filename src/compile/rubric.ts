import type { Compiled } from './schema.ts';

export type ScoringText = {
  niceToHave: { name: string; text: string }[];
  profiles: { name: string; dream: string; examples: string }[];
};

/** The rubric text the scorer and the bot's advisor get (masked later by buildScoreContext / buildBotMasking). */
export function buildRubric(c: Compiled, t: ScoringText, activeProfiles: string[]): string {
  const activeLower = new Set(activeProfiles.map(n => n.toLowerCase()));
  const active = c.profiles.filter(p => activeLower.has(p.name.toLowerCase()));

  const lines: string[] = [
    'Score 0-10 how well a job fits this candidate: 8-10 apply now, 5-7 worth a look, 3-4 a stretch, 0-2 not a fit.',
  ];

  for (const profile of active) {
    const tp = t.profiles.find(p => p.name.toLowerCase() === profile.name.toLowerCase());
    if (!tp) continue;

    lines.push('');
    lines.push(`## Profile: ${profile.name}`);
    lines.push("### Dream job (the candidate's words)");
    lines.push(tp.dream);

    if (tp.examples.trim()) {
      lines.push("### Jobs they would love or skip (the candidate's words)");
      lines.push(tp.examples);
    }

    if (profile.examples.length > 0) {
      lines.push('### Example roles');
      lines.push('| Role | Score |');
      lines.push('|---|---|');
      for (const ex of profile.examples) {
        lines.push(`| ${ex.role} | ${ex.score} |`);
      }
    }
  }

  const niceToHave = t.niceToHave.filter(c => c.text.trim().toLowerCase() !== 'none');
  if (niceToHave.length > 0) {
    lines.push('');
    lines.push('## What matters to the candidate');
    for (const card of niceToHave) {
      lines.push(`**${card.name}:** ${card.text}`);
    }
  }

  return lines.join('\n');
}
