import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Env } from './pipeline/llm.ts';
import { main as runMain } from './run.ts';

const USAGE = 'Usage: main.ts serve | run [flags] | check';

/** Appends `--trigger <RUN_TRIGGER>` when argv has no `--trigger` and `RUN_TRIGGER` is set. */
export function withTrigger(argv: string[], env: Env): string[] {
  if (argv.includes('--trigger') || !env.RUN_TRIGGER) return argv;
  return [...argv, '--trigger', env.RUN_TRIGGER];
}

export async function dispatch(
  argv: string[],
  env: Env,
  o?: {
    run?: typeof runMain;
    serve?: (argv: string[], env: Env) => Promise<void>;
    check?: () => Promise<string>;
    out?: (s: string) => void;
  },
): Promise<number> {
  const out = o?.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const [cmd, ...rest] = argv;

  if (cmd === 'run') {
    const run = o?.run ?? runMain;
    return run(withTrigger(rest, env), env);
  }

  if (cmd === 'serve') {
    if (o?.serve) {
      await o.serve(rest, env);
      return 0;
    }
    // Dynamic import keeps serve.ts out of the run-command load path.
    const { main: serveMain } = await import('./serve.ts');
    await serveMain(env);
    return 0;
  }

  if (cmd === 'check') {
    const checkFn = o?.check ?? defaultCheck;
    out(await checkFn());
    return 0;
  }

  out(USAGE);
  return 2;
}

const execFileP = promisify(execFile);

/** Prints node and claude versions; uses only PATH and HOME so the subprocess cannot read secrets. */
async function defaultCheck(): Promise<string> {
  const { stdout } = await execFileP('claude', ['--version'], {
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv,
  });
  return `node ${process.version}\n${stdout.trim()}`;
}

if (import.meta.main) {
  dispatch(process.argv.slice(2), process.env as Env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
