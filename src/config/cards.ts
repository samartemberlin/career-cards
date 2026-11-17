// Card catalogue: one CardSpec per Trello card in the Profiles board template.

export type CardKey =
  | 'where' | 'contract' | 'languages' | 'never'          // Deal-breakers
  | 'size' | 'industries' | 'matters'                     // Nice to have
  | 'roles' | 'words' | 'dream' | 'examples' | 'active'   // one list per profile
  | 'cv' | 'details';                                     // About me

export type CardSpec = { key: CardKey; name: string; questions: string[]; required: boolean };

export const LISTS = {
  dealBreakers: 'Deal-breakers',
  niceToHave: 'Nice to have',
  aboutMe: 'About me',
} as const;

export const DEAL_BREAKERS: CardSpec[] = [
  {
    key: 'where',
    name: 'Where & how I work',
    required: true,
    questions: [
      'Which countries or cities?',
      'Onsite, hybrid or remote?',
      'Anything that depends on something else (e.g. remote only if full-time)?',
    ],
  },
  {
    key: 'contract',
    name: 'Contract & visa',
    required: true,
    questions: [
      'What contract types do you accept? None means any.',
      'Any visa or work permit requirements? None means no constraints.',
    ],
  },
  {
    key: 'languages',
    name: 'Languages',
    required: true,
    questions: [
      'Which languages are required, and at what level? None means no language filter.',
    ],
  },
  {
    key: 'never',
    name: 'Never these companies or words',
    required: true,
    questions: [
      'Companies to never apply to, one per line. None means no exclusions.',
      'Words or patterns to always reject, one per line. None means no exclusions.',
    ],
  },
];

export const NICE_TO_HAVE: CardSpec[] = [
  {
    key: 'size',
    name: 'Company size',
    required: true,
    questions: [
      'What company sizes do you prefer? None means no preference.',
    ],
  },
  {
    key: 'industries',
    name: 'Industries I like',
    required: true,
    questions: [
      'Which industries do you like? None means no preference.',
      'Any to avoid? None means none.',
    ],
  },
  {
    key: 'matters',
    name: 'What matters to me',
    required: true,
    questions: [
      'What matters most to you in a job? None means no specific priorities.',
    ],
  },
];

export const PROFILE: CardSpec[] = [
  {
    key: 'roles',
    name: "Role names I'd take",
    required: true,
    questions: [
      "Which role names would you take, one per line? None means no title filter.",
    ],
  },
  {
    key: 'words',
    name: 'Words I want / avoid',
    required: true,
    questions: [
      'Words you want in job titles, one per line. None means no word filter.',
      'Words to avoid, one per line. None means none to avoid.',
    ],
  },
  {
    key: 'dream',
    name: 'My dream job',
    required: true,
    questions: [
      'Describe it in a few sentences: role, kind of company, what it does, pay, team.',
    ],
  },
  {
    key: 'examples',
    name: "Jobs I'd love / jobs I'd skip",
    required: false,
    questions: [
      "Jobs you'd love, one per line. None means no examples.",
      "Jobs you'd skip, one per line. None means none to skip.",
    ],
  },
  {
    key: 'active',
    name: 'Active',
    required: true,
    questions: [
      'Is this profile switched on? Write yes or no.',
    ],
  },
];

export const ABOUT_ME: CardSpec[] = [
  {
    key: 'cv',
    name: 'CV',
    required: true,
    questions: [
      'Paste your CV here as text.',
    ],
  },
  {
    key: 'details',
    name: 'Personal details',
    required: true,
    questions: [
      'One per line: your name, email, phone, address, links, small employers. Never sent to a model.',
    ],
  },
];

const ALL: CardSpec[] = [...DEAL_BREAKERS, ...NICE_TO_HAVE, ...PROFILE, ...ABOUT_ME];
const BY_KEY = new Map<CardKey, CardSpec>(ALL.map((s) => [s.key, s]));

export const specOf = (key: CardKey): CardSpec => {
  const s = BY_KEY.get(key);
  if (!s) throw new Error(`unknown card key: ${key}`);
  return s;
};

/** The template a new card starts with: the questions, one per line, each in `_…_`. */
export function templateOf(spec: CardSpec): string {
  const lines = spec.questions.map((q) => `_${q}_`);
  if (spec.key === 'active') lines.push('yes');
  return lines.join('\n');
}

/** The user's text: `desc` without the template's question lines, trimmed. '' means not filled in. */
export function answerOf(spec: CardSpec, desc: string): string {
  const questionLines = new Set(spec.questions.map((q) => `_${q}_`));
  return desc
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .filter((line) => !questionLines.has(line.trim()))
    .join('\n')
    .trim();
}
