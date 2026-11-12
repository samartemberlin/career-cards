import type { BotApi } from '../trello/api.ts';
import type { UserBoards } from '../trello/scoped.ts';
import { botMarkers } from './marker.ts';
import type { CapClass } from './marker.ts';
import type { ActionSpec, Stage } from './catalogue.ts';
import type { Settings } from '../config/schema.ts';

export type Usage = { static: number; model: number; research: number; modelByCard: Map<string, number> };

export async function loadUsage(api: BotApi, boards: UserBoards, o: { botId: string; now: Date }): Promise<Usage> {
  const since = new Date(o.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const boardIds = [boards.jobs, boards.profiles, boards.system];

  const allComments = (await Promise.all(boardIds.map((id) => api.boardComments(id, { since })))).flat();

  const usage: Usage = { static: 0, model: 0, research: 0, modelByCard: new Map() };
  for (const { cls, comment } of botMarkers(allComments, o.botId)) {
    if (cls === 'refusal') continue;
    if (cls === 'static') {
      usage.static++;
    } else if (cls === 'model') {
      usage.model++;
      usage.modelByCard.set(comment.cardId, (usage.modelByCard.get(comment.cardId) ?? 0) + 1);
    } else {
      // research
      usage.research++;
      usage.modelByCard.set(comment.cardId, (usage.modelByCard.get(comment.cardId) ?? 0) + 1);
    }
  }
  return usage;
}

const STAGE_TO_CLASS: Record<Stage, CapClass> = {
  code: 'static',
  reader: 'model',
  advisor: 'model',
  researcher: 'research',
  'researcher+advisor': 'research',
};

export function capClassOf(spec: ActionSpec | null): CapClass {
  return spec === null ? 'static' : STAGE_TO_CLASS[spec.stage];
}

export function overCap(cls: CapClass, cardId: string, u: Usage, caps: Settings['caps']): string | null {
  if (cls === 'static') {
    if (u.static >= caps.static_per_day) {
      return `Daily limit reached: ${caps.static_per_day} commands a day (Settings › caps.static_per_day). Try again tomorrow.`;
    }
    return null;
  }

  // Both model and research share the model-bucket checks.
  if (u.model + u.research >= caps.model_per_day) {
    return `Daily limit reached: ${caps.model_per_day} model requests a day (Settings › caps.model_per_day). Try again tomorrow.`;
  }
  const cardCount = u.modelByCard.get(cardId) ?? 0;
  if (cardCount >= caps.model_per_card_per_day) {
    return `Daily limit reached: ${caps.model_per_card_per_day} model requests on this card a day (Settings › caps.model_per_card_per_day). Try again tomorrow.`;
  }

  if (cls === 'research' && u.research >= caps.research_per_day) {
    return `Daily limit reached: ${caps.research_per_day} research requests a day (Settings › caps.research_per_day). Try again tomorrow.`;
  }
  return null;
}
