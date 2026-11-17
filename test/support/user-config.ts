// A UserConfig for unit tests, without a Trello board behind it.
import { specOf } from '../../src/config/cards.ts';
import type { CardKey } from '../../src/config/cards.ts';
import type { Settings, UserConfig } from '../../src/config/schema.ts';
import type { BoardCard, ProfilesBoard } from '../../src/trello/profiles-board.ts';

const card = (key: CardKey, text: string): BoardCard => {
  const name = specOf(key).name;
  return { key, name, text, ref: { id: `card-${key}`, name, url: `https://trello.com/c/${key}`, board: 'profiles' } };
};

/** One card per required spec; every active profile gets `dream` as its dream-job text. */
export function testBoard(o: { dream: string; cv: string; personalDetails: string[]; profiles?: { name: string; active: boolean }[] }): ProfilesBoard {
  const profiles = o.profiles ?? [{ name: 'Default', active: true }];
  return {
    dealBreakers: [card('where', 'Berlin'), card('contract', 'None'), card('languages', 'None'), card('never', 'None')],
    niceToHave: [card('size', 'None'), card('industries', 'None'), card('matters', 'None')],
    profiles: profiles.map((p) => ({
      ...p,
      cards: p.active ? [card('roles', 'Editor'), card('words', 'None'), card('dream', o.dream)] : [],
    })),
    cv: o.cv,
    personalDetails: o.personalDetails,
  };
}

export function testConfig(o: {
  settings: Settings; dream: string; cv: string; personalDetails: string[]; profiles?: { name: string; active: boolean }[];
}): UserConfig {
  const board = testBoard(o);
  return { settings: o.settings, sources: { add: [], drop: [] }, board, sharedCv: board.cv, personalDetails: board.personalDetails };
}
