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
};

export const COMPANY_TOPICS = ['about', 'openings', 'locations', 'news', 'reputation'] as const;
export const FEEDBACK_MAX = 2000;
export const REPLY_MAX = 4000;

const NoArgs = z.object({}).strict();
const noText = (rest: string): unknown => (rest ? { unexpected: rest } : {});

const simple = (id: string, verbs: string[], stage: Stage): ActionSpec =>
  ({ id, verbs, stage, router: 'auto', args: NoArgs, textArgs: noText, usage: `${verbs[0]}, with nothing after it` });

export const CATALOGUE: ActionSpec[] = [
  simple('check_open', ['open', 'offen'], 'code'),
  simple('check_legit', ['legit', 'echt'], 'reader'),
  simple('apply_needs', ['needs'], 'reader'),
  simple('explain_fit', ['fit'], 'advisor'),
  simple('cv_tips', ['cv', 'lebenslauf'], 'advisor'),
  simple('job_deep_dive', ['deep'], 'researcher+advisor'),
  {
    id: 'company_research', verbs: ['company', 'firma'], stage: 'researcher', router: 'auto',
    args: z.object({ topic: z.enum(COMPANY_TOPICS).default('about') }).strict(),
    textArgs: (rest) => (rest ? { topic: rest.toLowerCase() } : {}),
    usage: `company [${COMPANY_TOPICS.join(' | ')}], default about`,
  },
  {
    id: 'explain_filter', verbs: ['why', 'warum'], stage: 'code', router: 'auto',
    args: z.object({
      // The link ends up in a reply comment, so only web links are allowed (no javascript:, data:, file:).
      link: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: 'only http(s) links' }),
    }).strict(),
    textArgs: (rest) => ({ link: rest }),
    usage: 'why <link to the job posting>',
  },
  {
    id: 'record_feedback', verbs: ['feedback'], stage: 'code', router: 'confirm',
    args: z.object({ text: z.string().min(1).max(FEEDBACK_MAX) }).strict(),
    textArgs: (rest) => ({ text: rest }),
    usage: `feedback <your words, 1 to ${FEEDBACK_MAX} characters>`,
  },
  simple('show_last_run', ['last'], 'code'),
  { ...simple('start_run', ['run'], 'code'), router: 'confirm' },
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
  const parsed = spec.args.safeParse(spec.textArgs(rest));
  if (parsed.success) return { kind: 'action', spec, args: parsed.data };
  return { kind: 'bad_args', spec, message: `Use: ${spec.usage}` };
}
