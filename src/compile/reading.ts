import { oneLine } from '../bot/stages/call.ts';
import { displayName } from './compile.ts';
import type { CardText, CompileInput } from './compile.ts';
import type { Compiled } from './schema.ts';

export type CardReading = { card: string; hardRules: string[]; scoring: string[]; unused: { text: string; reason: string }[] };

const SHOWN = 8;
const list = (xs: string[]): string =>
  xs.length > SHOWN ? `${xs.slice(0, SHOWN).join(', ')} … and ${xs.length - SHOWN} more` : xs.join(', ');
const rule = (label: string, xs: string[]): string[] => (xs.length ? [`${label}: ${list(xs)}`] : []);

const AS_WRITTEN = 'Sent to scoring as written';
const LIMITS_NOTE = "Language and experience limits lower a job's ranking only in the run notes for now; they do not drop jobs.";

const CODE_TO_NAME: Record<string, string> = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', ru: 'Russian', tr: 'Turkish',
  ar: 'Arabic', uk: 'Ukrainian',
};
const langName = (code: string): string => CODE_TO_NAME[code] ?? code.toUpperCase();

function dealBreaker(c: Compiled, card: CardText): Pick<CardReading, 'hardRules' | 'scoring'> {
  switch (card.key) {
    case 'where': return {
      hardRules: [
        ...(c.places.anywhere ? ['Keep jobs anywhere'] : rule('Keep jobs located in', c.places.keep)),
        ...rule('Drop jobs located in', c.places.drop),
        ...rule('Remote jobs only if', c.employment.remote_only),
        ...rule('LinkedIn searches in', c.linkedin_locations.map((l) => (l.remote ? `${l.location} (remote)` : l.location))),
      ],
      scoring: [],
    };
    case 'contract': return { hardRules: rule('Keep only these contracts', c.employment.keep), scoring: [] };
    case 'languages': {
      const langLines: string[] = [];
      for (const [code, skill] of Object.entries(c.languages)) {
        const levels = (['read', 'write', 'speak'] as const).filter((k) => skill[k]).map((k) => `${k} ${skill[k]}`);
        if (levels.length) langLines.push(`${langName(code)}: ${levels.join(', ')}`);
      }
      const scoring = [
        ...langLines,
        ...(c.years_experience !== null ? [`Experience: ${c.years_experience} years`] : []),
      ];
      return { hardRules: [], scoring: scoring.length ? [...scoring, LIMITS_NOTE] : [] };
    }
    case 'never': return {
      hardRules: [...rule('Drop these companies', c.company_exclude), ...rule('Drop jobs whose text says', c.text_exclude)],
      scoring: [],
    };
    default: return { hardRules: [], scoring: [] };
  }
}

function profileCard(c: Compiled, profile: string, card: CardText): Pick<CardReading, 'hardRules' | 'scoring'> {
  const p = c.profiles.find((x) => x.name.toLowerCase() === profile.toLowerCase());
  if (!p) return { hardRules: [], scoring: [] };
  switch (card.key) {
    case 'roles': return { hardRules: [...rule('Search for', p.search_terms), ...rule('Keep job titles containing', p.title_include)], scoring: [] };
    case 'words': return { hardRules: rule('Drop job titles containing', p.title_exclude), scoring: [] };
    case 'dream': return { hardRules: [], scoring: [AS_WRITTEN, ...rule('Example roles', p.examples.map((e) => `${e.role} ${e.score}`))] };
    case 'examples': return { hardRules: [], scoring: [AS_WRITTEN] };
    default: return { hardRules: [], scoring: [] };
  }
}

const isNone = (text: string): boolean => /^none\.?$/i.test(text.trim());

/** One entry per card the user wrote, in board order. Rendered from `compiled` by code; only `unused` is model text. */
export function readingOf(c: Compiled, input: CompileInput, niceToHave: { name: string; text: string }[]): CardReading[] {
  const out: CardReading[] = [
    ...input.dealBreakers.map((card) => ({ card: card.name, ...dealBreaker(c, card), unused: [] })),
    ...niceToHave.map((n) => ({ card: n.name, hardRules: [], scoring: [isNone(n.text) ? 'Nothing to use ("none")' : AS_WRITTEN], unused: [] })),
    ...input.profiles.flatMap((p) => p.cards.map((card) => ({ card: displayName(p.name, card.name), ...profileCard(c, p.name, card), unused: [] }))),
  ];
  const other: CardReading = { card: 'Other', hardRules: [], scoring: [], unused: [] };
  for (const u of c.unused) {
    const home = out.find((r) => r.card.toLowerCase() === u.card.toLowerCase()) ?? other;
    home.unused.push({ text: u.text, reason: u.reason });
  }
  if (other.unused.length) out.push(other);
  return out;
}

export function readingText(r: CardReading[], o: { max?: number } = {}): string {
  const text = r.map((e) => [
    `**${oneLine(e.card)}**`,
    `Hard rules: ${e.hardRules.length ? e.hardRules.map(oneLine).join('; ') : 'none'}`,
    ...(e.scoring.length ? [`Used by scoring: ${e.scoring.map(oneLine).join('; ')}`] : []),
    ...(e.unused.length ? [`Not used: ${e.unused.map((u) => `${oneLine(u.text)} (${oneLine(u.reason)})`).join('; ')}`] : []),
  ].join('\n')).join('\n\n');
  return o.max !== undefined && text.length > o.max ? `${text.slice(0, o.max - 1)}…` : text;
}
