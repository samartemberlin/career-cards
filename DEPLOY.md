# Deploy

Northflank. The [template](deploy/northflank/template.json) creates one ManualJob (`run`) and one
DeploymentService (`serve`) in your project.

## Env contract

| Variable | Job | Service |
|---|:---:|:---:|
| `JOBS_BOARD_ID`, `PROFILES_BOARD_ID`, `SYSTEM_BOARD_ID` | ✓ | ✓ |
| `PUBLIC_URL` (HTTPS origin, no path; fill after first deploy) | | ✓ |
| `NORTHFLANK_PROJECT_ID` (injected via `${args.PROJECT_ID}`) | | ✓ |
| `NORTHFLANK_JOB_ID` (injected via `${refs.job.id}`) | | ✓ |
| `NORTHFLANK_API_TOKEN` (secret group `<worker>-service`, restricted to `serve`) | | ✓ |
| `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_APP_SECRET`, `TRIGGER_SECRET` (secret group `<worker>`) | ✓ | ✓ |
| LLM keys: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, … (secret group `<worker>`) | ✓ | |

## Steps

1. Fork `samartemberlin/career-cards`.
2. Make the GHCR package public (GitHub package settings → Change visibility → Public), or add registry
   credentials to Northflank and pass the image in the `IMAGE` argument.
3. Run `tools/onboard.ts` for the boards; it prints the three board IDs.
4. Create secret group `<worker>` (Trello creds, `TRIGGER_SECRET`, LLM keys; assign to both resources) and
   secret group `<worker>-service` (`NORTHFLANK_API_TOKEN` only, restricted to `serve`).
5. Run the template (Templates → Import JSON). Fill all no-default arguments; leave `PUBLIC_URL` empty.
6. Copy the `serve` URL into `PUBLIC_URL` and re-run the template.
7. Run `tools/onboard.ts --url <service url>` to register webhooks.
8. Create the Trello automation rule by hand (Automation → Rules; Trello has no API for it). The tool prints
   the rule with the placeholder `<TRIGGER_SECRET>`; replace it before saving.
9. Comment `@bot run` on a System board card.

## Northflank notes

- **API token permissions** (project-scoped, not personal): Jobs › General › *Read*; *Run Job*.
  This project only; never reach `run`.
- **One worker per Northflank project.** Unrestricted groups apply to everything in the project.
- **Incidents:** check [status.northflank.com](https://status.northflank.com) if something looks wrong;
  rotate `NORTHFLANK_API_TOKEN` and all Trello credentials if an advisory recommends it.

## Adding a platform

- Add a folder `deploy/<name>/` with the platform's template or manifest.
- Supply the same env contract.
- Run a long-running `serve` with public HTTPS. Then either add a one-shot job API and a [`JobStarter`](src/serve/northflank.ts),
  or omit the `NORTHFLANK_*` variables and let `serve` run the job as a child process (needs ≥ 1 GB RAM).

Some free LLM tiers may train on prompts; check each provider's terms before use.
