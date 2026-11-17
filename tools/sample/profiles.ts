import { DEAL_BREAKERS, NICE_TO_HAVE, PROFILE, ABOUT_ME, LISTS, templateOf } from '../../src/config/cards.ts';
import type { CardSpec } from '../../src/config/cards.ts';
import type { CardSpec as LayoutCardSpec, BoardLayout } from './layout.ts';
import { CV } from './layout.ts';

// Personal details as text lines (one per line), matching the Alex Example values in layout.ts.
const DETAILS_TEXT = [
  'Alex Example',
  'alex.example@example.com',
  '+49 30 0000000',
  'address: Examplestraße 1, 10115 Berlin',
  'https://example.com/alex',
].join('\n');

const toCard = (spec: CardSpec, desc: string): LayoutCardSpec => ({ name: spec.name, desc });

function dealBreakerCards(): LayoutCardSpec[] {
  const [where, contract, languages, never] = DEAL_BREAKERS;
  return [
    toCard(where!, 'Berlin, onsite or hybrid. Remote is fine anywhere in Germany or the EU, but only full-time. Not Munich.'),
    toCard(contract!, 'Employee contracts only, no freelance. Paid.'),
    toCard(languages!, 'English C1. German B2 reading, B1 writing and speaking. About 3 years of experience.'),
    toCard(never!, 'Example Staffing GmbH. Nothing unpaid.'),
  ];
}

function niceToHaveCards(): LayoutCardSpec[] {
  const [size, industries, matters] = NICE_TO_HAVE;
  return [
    toCard(size!, 'Small or mid-size, under 500 people.'),
    toCard(industries!, 'Publishing, media, culture, education.'),
    toCard(matters!, 'A real editing team. Salary above 45k.'),
  ];
}

function contentEditorCards(): LayoutCardSpec[] {
  const [roles, words, dream, examples, active] = PROFILE;
  return [
    toCard(roles!, 'Content editor, online editor, Redakteur, content manager'),
    toCard(words!, 'Avoid: senior, lead, head of'),
    toCard(dream!, 'Looking for a mid-size publisher or media company in Berlin with a real editing team. The role should focus on planning, writing and editing digital content, with room to shape editorial direction. Salary above 45k and two days remote per week.'),
    toCard(examples!, 'Content editor at Example Media GmbH — matches the profile well.\nOnline editor at Sample Verlag — interesting editorial work.\nSenior content manager at a large agency — too senior.\nMarketing writer at a consulting firm — not editorial enough.'),
    toCard(active!, 'yes'),
  ];
}

function copywriterCards(): LayoutCardSpec[] {
  const [roles, words, dream, examples, active] = PROFILE;
  return [
    toCard(roles!, 'Copywriter, Texter, content writer'),
    toCard(words!, 'Avoid: senior, lead'),
    toCard(dream!, 'A content-focused role at a small creative agency or in-house team. Writing across channels — web, email, social — with a clear brand voice. Around 40k, hybrid in Berlin.'),
    toCard(examples!, 'Copywriter at a design studio — creative freedom, small team.\nContent writer at a SaaS company — interesting domain.\nSEO writer at a content mill — too production-heavy.\nMarketing manager role — too broad, not writing-focused.'),
    toCard(active!, 'no'),
  ];
}

function aboutMeCards(): LayoutCardSpec[] {
  const [cv, details] = ABOUT_ME;
  return [
    toCard(cv!, CV),
    toCard(details!, DETAILS_TEXT),
  ];
}

export const SAMPLE_PROFILES: BoardLayout = {
  labels: [],
  lists: [
    { name: LISTS.dealBreakers, cards: dealBreakerCards() },
    { name: LISTS.niceToHave, cards: niceToHaveCards() },
    { name: 'Content editor', cards: contentEditorCards() },
    { name: 'Copywriter', cards: copywriterCards() },
    { name: LISTS.aboutMe, cards: aboutMeCards() },
    { name: 'Originals', cards: [{ name: 'CV (original)', desc: CV }] },
  ],
};

export function starterProfiles(): BoardLayout {
  const toTemplate = (spec: CardSpec): LayoutCardSpec => ({ name: spec.name, desc: templateOf(spec) });
  return {
    labels: [],
    lists: [
      { name: LISTS.dealBreakers, cards: DEAL_BREAKERS.map(toTemplate) },
      { name: LISTS.niceToHave, cards: NICE_TO_HAVE.map(toTemplate) },
      { name: 'My profile', cards: PROFILE.map(toTemplate) },
      { name: LISTS.aboutMe, cards: ABOUT_ME.map(toTemplate) },
    ],
  };
}
