import type { TList, TCard } from './api.ts';
import { DEAL_BREAKERS, NICE_TO_HAVE, PROFILE, ABOUT_ME, LISTS, answerOf } from '../config/cards.ts';
import type { CardKey, CardSpec } from '../config/cards.ts';
import type { CardRef, ConfigProblem } from './config.ts';

export type BoardCard = { key: CardKey; name: string; text: string; ref: CardRef };
export type ProfileCards = { name: string; active: boolean; cards: BoardCard[] };
export type ProfilesBoard = {
  dealBreakers: BoardCard[];
  niceToHave: BoardCard[];
  profiles: ProfileCards[];
  cv: string;
  personalDetails: string[];
};

const norm = (s: string) => s.trim().toLowerCase();

function openCols(lists: TList[], cards: TCard[]): { list: TList; cards: TCard[] }[] {
  return lists
    .filter((l) => !l.closed)
    .sort((a, b) => a.pos - b.pos)
    .map((list) => ({
      list,
      cards: cards.filter((c) => !c.closed && c.idList === list.id).sort((a, b) => a.pos - b.pos),
    }));
}

function cardRef(card: TCard): CardRef {
  return { id: card.id, name: card.name, url: card.shortUrl, board: 'profiles' };
}

type Col = { name: string; cards: TCard[] };

function pickCard(col: Col, spec: CardSpec, problems: ConfigProblem[]): TCard | undefined {
  const found = col.cards.filter((c) => norm(c.name) === norm(spec.name));
  if (found.length > 1) {
    problems.push({
      message: `${found.length} cards titled "${spec.name}" in column "${col.name}", keep one: ${found.map((f) => f.shortUrl).join(', ')}`,
      where: `Profiles › ${col.name} › ${spec.name}`,
      card: cardRef(found[0]!),
    });
    return undefined;
  }
  if (!found.length && spec.required) {
    problems.push({
      message: `missing the "${spec.name}" card in column "${col.name}"`,
      where: `Profiles › ${col.name}`,
    });
    return undefined;
  }
  return found[0];
}

function toBoardCard(col: Col, spec: CardSpec, problems: ConfigProblem[]): BoardCard | undefined {
  const card = pickCard(col, spec, problems);
  if (!card) return undefined;
  const text = answerOf(spec, card.desc);
  if (spec.required && text === '') {
    problems.push({
      message: `the "${spec.name}" card is not filled in (it still holds only its questions)`,
      where: `Profiles › ${col.name} › ${spec.name}`,
      card: cardRef(card),
    });
  }
  return { key: spec.key, name: spec.name, text, ref: cardRef(card) };
}

/** Process personal details lines from the raw desc (before the whole-string trim of answerOf). */
function personalDetailsOf(spec: CardSpec, desc: string): string[] {
  const questionLines = new Set(spec.questions.map((q) => `_${q}_`));
  return desc
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .filter((l) => !questionLines.has(l.trim()))
    .map((l) => (l.startsWith('- ') ? l.slice(2) : l.startsWith('* ') ? l.slice(2) : l))
    .filter((l) => l.trim() !== '');
}

function readFixedList(
  all: { list: TList; cards: TCard[] }[],
  listName: string,
  specs: CardSpec[],
  problems: ConfigProblem[],
): BoardCard[] {
  const col = all.find((x) => norm(x.list.name) === norm(listName));
  if (!col) {
    problems.push({ message: `no "${listName}" column`, where: 'Profiles board' });
    return [];
  }
  const c: Col = { name: col.list.name.trim(), cards: col.cards };
  return specs.flatMap((spec) => {
    const bc = toBoardCard(c, spec, problems);
    return bc ? [bc] : [];
  });
}

function readProfileCol(col: { list: TList; cards: TCard[] }, problems: ConfigProblem[]): ProfileCards {
  const listName = col.list.name.trim();
  const c: Col = { name: listName, cards: col.cards };

  const activeSpec = PROFILE.find((s) => s.key === 'active')!;
  const activeCard = pickCard(c, activeSpec, problems);
  let active = false;

  if (activeCard) {
    const text = answerOf(activeSpec, activeCard.desc).toLowerCase();
    if (!text.startsWith('yes') && !text.startsWith('no')) {
      problems.push({
        message: `the "${activeSpec.name}" card must start with yes or no`,
        where: `Profiles › ${listName} › ${activeSpec.name}`,
        card: cardRef(activeCard),
      });
    } else {
      active = text.startsWith('yes');
    }
  }

  const cards: BoardCard[] = [];
  if (active) {
    for (const spec of PROFILE.filter((s) => s.key !== 'active')) {
      const bc = toBoardCard(c, spec, problems);
      if (bc) cards.push(bc);
    }
  }

  return { name: listName, active, cards };
}

/** Collects every problem, like readUserConfig; the caller throws ConfigInvalid. */
export function readProfilesBoard(
  lists: TList[],
  cards: TCard[],
): { board: ProfilesBoard | null; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const all = openCols(lists, cards);

  const FIXED = new Set([norm(LISTS.dealBreakers), norm(LISTS.niceToHave), norm(LISTS.aboutMe), 'originals']);

  // Detect duplicate names among all non-Originals open lists.
  const seenNames = new Map<string, string>();
  const dupeKeys = new Set<string>();
  for (const { list } of all) {
    const key = norm(list.name);
    if (key === 'originals') continue;
    if (seenNames.has(key)) {
      if (!dupeKeys.has(key)) {
        problems.push({ message: `two open columns named "${seenNames.get(key)!}", rename or archive one`, where: 'Profiles board' });
        dupeKeys.add(key);
      }
    } else {
      seenNames.set(key, list.name.trim());
    }
  }

  const dealBreakers = readFixedList(all, LISTS.dealBreakers, DEAL_BREAKERS, problems);
  const niceToHave = readFixedList(all, LISTS.niceToHave, NICE_TO_HAVE, problems);

  // Collect profile lists: not fixed, not Originals; keep only the first occurrence of each name.
  const profileColMap = new Map<string, { list: TList; cards: TCard[] }>();
  for (const col of all) {
    const key = norm(col.list.name);
    if (FIXED.has(key)) continue;
    if (!profileColMap.has(key)) profileColMap.set(key, col);
  }
  const profileCols = [...profileColMap.values()];

  if (profileCols.length === 0) {
    problems.push({ message: 'no profile column found', where: 'Profiles board' });
  }

  const profiles = profileCols.map((col) => readProfileCol(col, problems));

  if (profiles.length > 0 && profiles.every((p) => !p.active)) {
    problems.push({ message: 'at least one profile must be active', where: 'Profiles board' });
  }

  // About me: CV and Personal details.
  let cv = '';
  let personalDetails: string[] = [];
  const aboutMeCol = all.find((x) => norm(x.list.name) === norm(LISTS.aboutMe));

  if (!aboutMeCol) {
    problems.push({ message: `no "${LISTS.aboutMe}" column`, where: 'Profiles board' });
  } else {
    const c: Col = { name: LISTS.aboutMe, cards: aboutMeCol.cards };

    const cvSpec = ABOUT_ME.find((s) => s.key === 'cv')!;
    const cvCard = pickCard(c, cvSpec, problems);
    if (cvCard) {
      const answer = answerOf(cvSpec, cvCard.desc);
      if (answer === '') {
        problems.push({
          message: `the "${cvSpec.name}" card is not filled in (it still holds only its questions)`,
          where: `Profiles › ${LISTS.aboutMe} › ${cvSpec.name}`,
          card: cardRef(cvCard),
        });
      } else if (/^none\.?$/i.test(answer)) {
        problems.push({
          message: `the ${cvSpec.name} card must hold your CV`,
          where: `Profiles › ${LISTS.aboutMe} › ${cvSpec.name}`,
          card: cardRef(cvCard),
        });
      } else {
        cv = answer;
      }
    }

    const detSpec = ABOUT_ME.find((s) => s.key === 'details')!;
    const detCard = pickCard(c, detSpec, problems);
    if (detCard) {
      const answer = answerOf(detSpec, detCard.desc);
      if (answer === '') {
        problems.push({
          message: `the "${detSpec.name}" card is not filled in (it still holds only its questions)`,
          where: `Profiles › ${LISTS.aboutMe} › ${detSpec.name}`,
          card: cardRef(detCard),
        });
      } else {
        personalDetails = personalDetailsOf(detSpec, detCard.desc);
        if (personalDetails.length === 0) {
          problems.push({
            message: 'Personal details: list at least one item, one per line',
            where: `Profiles › ${LISTS.aboutMe} › ${detSpec.name}`,
            card: cardRef(detCard),
          });
        }
      }
    }
  }

  if (problems.length > 0) return { board: null, problems };
  return { board: { dealBreakers, niceToHave, profiles, cv, personalDetails }, problems: [] };
}
