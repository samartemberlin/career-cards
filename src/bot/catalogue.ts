// The only things the bot can do. The router model may return nothing but a catalogued id with args from its schema,
// so RouterOutputSchema is a security boundary: keep every args schema strict and its values closed or format-checked.
import { z } from 'zod';

export type Stage = 'code' | 'reader' | 'advisor' | 'researcher' | 'researcher+advisor';

export type ActionSpec = {
  id: string;
  /** The English verb first, then aliases. Matched case-insensitively. */
  verbs: string[];
  stage: Stage;
  router: 'auto' | 'confirm';
  args: z.ZodType;
  /** Turns the text after a static verb into the input for `args`. */
  textArgs: (rest: string) => unknown;
  /** Shown when a static command's arguments don't parse. */
  usage: string;
  /** The help line: what the action tells the user. */
  about: string;
};

export const COMPANY_TOPICS = ['about', 'openings', 'locations', 'news', 'reputation'] as const;
export const FEEDBACK_MAX = 2000;
export const REPLY_MAX = 4000;

const NoArgs = z.object({}).strict();

const simple = (id: string, verbs: string[], stage: Stage, about: string): ActionSpec =>
  ({ id, verbs, stage, router: 'auto', args: NoArgs, textArgs: () => ({}), usage: verbs[0]!, about });

export const CATALOGUE: ActionSpec[] = [
  simple('check_open', ['open', 'offen'], 'code', 'whether the posting is still live.'),
  simple('check_legit', ['legit', 'echt'], 'reader', 'whether the posting is real and current: ghost-job and scam signals.'),
  simple('apply_needs', ['needs'], 'reader', 'what applying takes: documents, language, deadline, how to apply.'),
  simple('explain_fit', ['fit'], 'advisor', 'why the job scored what it did: strong points, gaps, deal-breakers.'),
  simple('cv_tips', ['cv', 'lebenslauf'], 'advisor', 'how to target your CV for this job.'),
  simple('job_deep_dive', ['deep'], 'researcher+advisor', 'public facts about the role and company, then how you would match this job.'),
  {
    id: 'company_research', verbs: ['company', 'firma'], stage: 'researcher', router: 'auto',
    args: z.object({ topic: z.enum(COMPANY_TOPICS).default('about') }).strict(),
    textArgs: (rest) => (rest ? { topic: rest.toLowerCase() } : {}),
    usage: `company [${COMPANY_TOPICS.join(' | ')}], default about`,
    about: 'the company: what they do, other openings, locations, news or reputation.',
  },
  {
    id: 'explain_filter', verbs: ['why', 'warum'], stage: 'code', router: 'auto',
    args: z.object({
      // The link ends up in a reply comment, so only web links are allowed (no javascript:, data:, file:).
      link: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: 'only http(s) links' }),
    }).strict(),
    textArgs: (rest) => ({ link: rest }),
    usage: 'why <link to the job posting>',
    about: 'which rule rejected a job that has no card, with the matched text.',
  },
  {
    id: 'record_feedback', verbs: ['feedback'], stage: 'code', router: 'confirm',
    args: z.object({ text: z.string().min(1).max(FEEDBACK_MAX) }).strict(),
    textArgs: (rest) => ({ text: rest }),
    usage: `feedback <your words, 1 to ${FEEDBACK_MAX} characters>`,
    about: 'your words posted verbatim on the active profile\'s Feedback card, after you confirm.',
  },
  simple('show_last_run', ['last'], 'code', 'a summary of the latest run, with a link.'),
  { ...simple('start_run', ['run'], 'code', 'starts a manual run, after you confirm.'), router: 'confirm' },
];

const BUILTINS = new Map<string, 'help' | 'yes' | 'no'>([['help', 'help'], ['hilfe', 'help'], ['yes', 'yes'], ['ja', 'yes'], ['no', 'no'], ['nein', 'no']]);

const actionOption = (s: ActionSpec) => z.object({ id: z.literal(s.id), args: s.args }).strict();
type ActionOption = ReturnType<typeof actionOption>;

export const RouterOutputSchema = z.object({
  reply: z.string().max(REPLY_MAX),
  action: z.discriminatedUnion('id', CATALOGUE.map(actionOption) as [ActionOption, ActionOption, ...ActionOption[]]).nullable(),
}).strict();
export type RouterOutput = z.infer<typeof RouterOutputSchema>;

export type StaticMatch =
  | { kind: 'builtin'; name: 'help' | 'yes' | 'no' }
  | { kind: 'action'; spec: ActionSpec; args: unknown }
  | { kind: 'none' }
  | { kind: 'bad_args'; spec: ActionSpec; message: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A comment that starts with `@<botName> <verb>`. Anything that isn't a full static command is `none` and goes to the router. */
export function matchStatic(comment: string, botName: string): StaticMatch {
  const m = new RegExp(`^\\s*@${escapeRe(botName)}(?=\\s|$)\\s*(\\S*)([\\s\\S]*)$`, 'i').exec(comment);
  if (!m) return { kind: 'none' };
  const word = m[1]!.toLowerCase();
  const rest = m[2]!.trim();

  // A builtin only counts on its own: "yes, but what about…" is a question for the router, not a confirmation.
  const builtin = BUILTINS.get(word);
  if (builtin) return rest ? { kind: 'none' } : { kind: 'builtin', name: builtin };

  const spec = CATALOGUE.find((s) => s.verbs.includes(word));
  if (!spec) return { kind: 'none' };
  // "@bot fit why so low?" is a question, not a command with bad arguments: free text is the router's job.
  if (rest && spec.args === NoArgs) return { kind: 'none' };
  const parsed = spec.args.safeParse(spec.textArgs(rest));
  if (parsed.success) return { kind: 'action', spec, args: parsed.data };
  return { kind: 'bad_args', spec, message: `Use: ${spec.usage}` };
}
