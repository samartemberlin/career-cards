import { jobCardDesc, jobCardTitle, RUN_SUMMARY_PREFIX } from '../../src/trello/cards.ts';
import { loadDefaults } from '../../src/run/sources-plan.ts';
import type { SampleBoard } from './guard.ts';
import { SAMPLE_PROFILES } from './profiles.ts';

export type ChecklistSpec = { name: string; items: string[] };
export type CardSpec = {
  name: string;
  desc: string;
  labels?: string[];
  checklists?: ChecklistSpec[];
  /** Only added when the card is created, since the API has no way to read comments or attachments back. */
  comment?: string;
  attachment?: { name: string; text: string };
  closed?: boolean;
};
export type ListSpec = { name: string; cards: CardSpec[]; closed?: boolean };
export type BoardLayout = { labels: { name: string; color: string }[]; lists: ListSpec[] };

/**
 * Description for the Sources card on the System board, generated from the built-in defaults.
 * Add checklist: extra sources beyond the defaults (URL for job boards, company name for tracked companies).
 * Drop checklist: built-in sources to skip for this user.
 * Empty checklists mean "use all built-in sources as-is".
 */
export function sourcesCardDesc(): string {
  const d = loadDefaults();
  const portals = d.portals as Record<string, { name?: string }[]>;
  const named = (arr: { name?: string }[] | undefined) =>
    (arr ?? []).map((x) => x.name).filter((n): n is string => Boolean(n));
  const boards = named(portals.job_boards);
  const interamt = named(portals.interamt_searches);
  const companies = named(portals.tracked_companies);
  const rss = named(d.extra.rss as { name?: string }[]);
  const pages = named(d.extra.pages as { name?: string }[]);
  const hasLinkedin = !!d.extra.linkedin;
  const lines: string[] = [
    'Add and Drop checklists override the built-in source list for this user.',
    '- **Add**: extra sources to scan (a career-page URL, or a company name that career-ops already tracks).',
    '- **Drop**: built-in sources to skip. Each item must match a source name exactly.',
    '- Empty checklists mean "use all built-in sources without change".',
    '',
    '**Built-in sources:**',
  ];
  if (boards.length) lines.push('', `Job boards (${boards.length}): ${boards.join(', ')}.`);
  if (interamt.length) lines.push('', `Interamt searches (${interamt.length}): ${interamt.join(', ')}.`);
  if (companies.length) lines.push('', `Tracked companies (${companies.length}): ${companies.join(', ')}.`);
  if (rss.length) lines.push('', `RSS feeds: ${rss.join(', ')}.`);
  if (pages.length) lines.push('', `Career pages: ${pages.join(', ')}.`);
  if (hasLinkedin) lines.push('', 'LinkedIn (public guest search, see extra-sources.yml for limits).');
  return lines.join('\n');
}

export const RUN_COLUMN = 'Nov 9 · 01:00';
export const OLD_RUN_COLUMN = 'Oct 1 · 01:00';
// Over 1,000 so that reading the Jobs board needs two pages.
export const FILLER_COUNT = 1050;

const COMPANIES = ['Example Media GmbH', 'Sample Verlag', 'Demo Studio Berlin', 'Placeholder AG', 'Fictional Books GmbH'];
const TITLES = ['Content Editor', 'Online-Redakteur (m/w/d)', 'Junior Copywriter', 'Content Manager', 'Editorial Assistant'];

function jobCard(n: number, closed = false): CardSpec {
  const remote = n % 2 === 0;
  const job = {
    key: `sample:job-${n}`,
    url: `https://jobs.example.com/sample-${n}`,
    company: COMPANIES[(n - 1) % COMPANIES.length]!,
    title: TITLES[(n - 1) % TITLES.length]!,
    location: remote ? 'Berlin (Remote)' : 'Berlin, Germany',
    posted: '2026-11-0' + ((n % 9) + 1),
    jd: `We are looking for a ${TITLES[(n - 1) % TITLES.length]} to plan, write and edit articles for our sample magazine.\n\n- Two years of editing\n- Good English, some German`,
    reason: 'Editing role in Berlin that matches the profile.',
    ...(n === 2 ? { title_en: 'Online Editor' } : {}),
  };
  const score = 9 - ((n - 1) % 5);
  return {
    name: jobCardTitle({ score, ...job }),
    desc: jobCardDesc(job).desc,
    labels: remote ? ['Berlin', 'Remote'] : ['Berlin'],
    ...(n === 1 ? {
      comment: 'Sample comment: looks like a good fit.',
      attachment: { name: 'job-description.md', text: `# ${job.title}\n\n${job.jd}\n` },
    } : {}),
    ...(closed ? { closed } : {}),
  };
}

function fillerCard(n: number): CardSpec {
  const nnnn = String(n).padStart(4, '0');
  return {
    name: jobCardTitle({ score: 2, company: 'Filler GmbH', title: `Sample role ${nnnn}` }),
    desc: `Filler card.\n\n---\ncareer-cards-key: sample:filler-${nnnn}`,
  };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const yaml = (body: string, note = ''): string => `${note ? `${note}\n\n` : ''}\`\`\`yaml\n${body}\`\`\``;

// The active profile's list also holds a Feedback card (the bot posts there) and a note card the reader ignores.
const profiles: BoardLayout = {
  labels: [],
  lists: [
    ...SAMPLE_PROFILES.lists.map((l) => (l.name !== 'Content editor' ? l : {
      ...l,
      cards: [
        ...l.cards,
        { name: 'Feedback', desc: 'Job feedback for this profile arrives here as comments.' },
        { name: 'My notes', desc: 'A note card: the bot ignores cards with other titles.' },
      ],
    })),
    { name: 'Old profile', closed: true, cards: [{ name: 'Active', desc: 'yes' }] },
  ],
};

export const LAYOUT: Record<SampleBoard, BoardLayout> = {
  jobs: {
    labels: [{ name: 'Berlin', color: 'green' }, { name: 'Remote', color: 'blue' }],
    lists: [
      {
        name: RUN_COLUMN,
        cards: [
          { name: `${RUN_SUMMARY_PREFIX} · ${RUN_COLUMN} · 5 cards`, desc: 'Scanned 412 · new 37 · rejected 25 · scored 10 · cards 5' },
          ...range(1, 5).map((n) => jobCard(n)),
          ...range(6, 10).map((n) => jobCard(n, true)),
        ],
      },
      { name: 'To apply', cards: [] },
      {
        name: 'Applied',
        cards: [{
          name: '7 · Old Example AG — Content Editor',
          desc: '**Old Example AG — Content Editor**\n\n**Link:** https://jobs.example.com/old-1\n\n---\n\nMigrated card.\n\n---\nsamjobs-key: sample:old-1',
        }],
      },
      { name: 'Interview', cards: [] },
      { name: 'Rejected', cards: [] },
      { name: 'Closed', cards: [] },
      { name: 'Dismissed', cards: [] },
      { name: OLD_RUN_COLUMN, cards: range(1, FILLER_COUNT).map(fillerCard), closed: true },
    ],
  },
  profiles,
  system: {
    labels: [],
    lists: [
      {
        name: 'Config',
        cards: [
          {
            name: 'Settings',
            desc: yaml(
              'timezone: Europe/Berlin\nproviders: [claude, gemini]\nallowed_members: [samplebot]\nbot_keyword: /bot\n',
              'Settings for the sample user. Only the YAML block is read.',
            ) + '\n\nNotes: providers are tried in order.',
          },
          {
            name: 'Sources',
            desc: sourcesCardDesc(),
            checklists: [
              { name: 'Add', items: ['Example GmbH — https://example.com/careers'] },
              { name: 'Drop', items: ['Old Example AG'] },
            ],
          },
          { name: 'Schedule', desc: 'The nightly run is started by a Trello automation rule at 01:00. Edit that rule to change the time.' },
        ],
      },
      { name: 'Runs', cards: [{ name: `✅ ${RUN_COLUMN} · scheduled · +5 cards`, desc: 'Scanned 412 · new 37 · scored 10 · cards 5' }] },
    ],
  },
};

export const cardCount = (b: BoardLayout): number => b.lists.reduce((n, l) => n + l.cards.length, 0);
