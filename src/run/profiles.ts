// The user's Profiles board as the run and the bot use it: one compile call turns the cards into filters, search
// terms and the rubric; the bot's model-free rubric is built from the card text alone.
import { compileCards } from '../compile/compile.ts';
import type { CardText, CompileInput } from '../compile/compile.ts';
import { compiledFilter } from '../compile/filter.ts';
import { readingOf } from '../compile/reading.ts';
import type { CardReading } from '../compile/reading.ts';
import { buildRubric } from '../compile/rubric.ts';
import type { ScoringText } from '../compile/rubric.ts';
import { preferencesOf } from '../compile/schema.ts';
import type { Compiled } from '../compile/schema.ts';
import type { UserConfig } from '../config/schema.ts';
import type { Job } from '../pipeline/keys.ts';
import type { CallOpts, LlmConfig } from '../pipeline/llm.ts';
import type { Preferences } from '../pipeline/prefs.ts';
import { buildMasker } from '../privacy.ts';
import type { BoardCard } from '../trello/profiles-board.ts';

const active = (cfg: UserConfig) => cfg.board.profiles.filter((p) => p.active);

export function activeProfileNames(cfg: UserConfig): string[] {
  return active(cfg).map((p) => p.name);
}

const cardText = (c: BoardCard): CardText => ({ key: c.key, name: c.name, text: c.text });

/** The cards the user wrote: an optional card left empty is not sent. */
export function compileInputOf(cfg: UserConfig): CompileInput {
  return {
    dealBreakers: cfg.board.dealBreakers.map(cardText),
    profiles: active(cfg).map((p) => ({ name: p.name, cards: p.cards.filter((c) => c.text).map(cardText) })),
  };
}

export function scoringTextOf(cfg: UserConfig): ScoringText {
  const textOf = (cards: BoardCard[], key: BoardCard['key']) => cards.find((c) => c.key === key)?.text ?? '';
  return {
    niceToHave: cfg.board.niceToHave.map((c) => ({ name: c.name, text: c.text })),
    profiles: active(cfg).map((p) => ({ name: p.name, dream: textOf(p.cards, 'dream'), examples: textOf(p.cards, 'examples') })),
  };
}

/** Nothing read from the cards: with it, buildRubric gives the cards' own words and no example table. */
export const EMPTY_COMPILED: Compiled = {
  places: { anywhere: true, keep: [], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [],
  text_exclude: [],
  languages: {},
  years_experience: null,
  profiles: [],
  unused: [],
  problems: [],
};

/** The bot's rubric, made without a model call. */
export function botRubric(cfg: UserConfig): string {
  const names = activeProfileNames(cfg);
  const profiles = names.map((name) => ({ name, search_terms: [], title_include: [], title_exclude: [], examples: [] }));
  return buildRubric({ ...EMPTY_COMPILED, profiles }, scoringTextOf(cfg), names);
}

/** Compiles the board: the one place the run and the bot get rules from. Throws CompileFailed / CompileUnavailable. */
export async function compileUser(cfg: UserConfig, o: {
  llm: LlmConfig; call?: CallOpts; log: (s: string) => void; deadline?: number; signal?: AbortSignal;
  attempts?: number; pauseMs?: number;
}): Promise<{ compiled: Compiled; reading: CardReading[]; filter: (job: Job) => string | null; rubric: string; preferences: Preferences }> {
  const input = compileInputOf(cfg);
  const { compiled } = await compileCards(input, { ...o, masker: buildMasker(cfg.personalDetails) });
  const names = activeProfileNames(cfg);
  const text = scoringTextOf(cfg);
  return {
    compiled,
    reading: readingOf(compiled, input, text.niceToHave),
    filter: compiledFilter(compiled, names),
    rubric: buildRubric(compiled, text, names),
    preferences: preferencesOf(compiled),
  };
}
