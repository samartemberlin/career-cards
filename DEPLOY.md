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
| `TRELLO_KEY`, `TRELLO_TOKEN` (secret group `<worker>`) | ✓ | ✓ |
| `TRELLO_APP_SECRET`, `TRIGGER_SECRET`, `NORTHFLANK_API_TOKEN` (secret group `<worker>-service`, restricted to `serve`) | | ✓ |
| LLM keys: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, … (secret group `<worker>-llm`; the bot builds its providers from `serve`'s env, [`stageOpts`](src/bot/stages/handler.ts#L19)) | ✓ | ✓ |
| `CLAUDE_CODE_OAUTH_TOKEN` (the owner's own Claude subscription; secret group `<worker>-claude`) | ✓ | [see below](#web-research-company-deep) |

## Steps

1. Fork `samartemberlin/career-cards`.
2. Make the GHCR package public (GitHub package settings → Change visibility → Public). For a fork, enable
   Actions first; the image is at `ghcr.io/<you>/career-cards:main`. The `:main` tag updates on every push to
   `main`; Northflank pulls it on the next service restart or job run.
3. Run `tools/onboard.ts` for the boards:
   - `--workspace <24-hex Trello workspace id>` (find it at trello.com/your-org/account → visible in the URL)
   - `--owner-user <trello-username>` (the board owner; or set `OWNER_TRELLO_KEY`/`OWNER_TRELLO_TOKEN` for a
     separate account)
   - Use `--dry-run` first to preview without creating anything.
   - `TRELLO_KEY` must be the same key the service uses: Trello signs webhooks with the app secret of the key
     that created them, so a mismatch causes every webhook to answer 401.
   - The tool prints the three board IDs; it stores them in `tools/.onboard.json`.
4. Run the template (Templates → Import JSON). Fill all no-default arguments; leave `PUBLIC_URL` empty for
   now. `serve` will fail its health check until steps 5–6 add secrets and `PUBLIC_URL` — that is expected.
5. Create secret group `<worker>` (`TRELLO_KEY`, `TRELLO_TOKEN`; assign to both resources), secret group
   `<worker>-llm` (LLM keys; both resources), secret group `<worker>-claude` (`CLAUDE_CODE_OAUTH_TOKEN`;
   restricted to `run`, add `serve` only as [below](#web-research-company-deep)), and secret group
   `<worker>-service` (`TRELLO_APP_SECRET`, `TRIGGER_SECRET`, `NORTHFLANK_API_TOKEN`; restricted to `serve` —
   the job never receives these). Each model process still gets only its own token.
   - Generate `TRIGGER_SECRET`: `openssl rand -hex 32` (must be ≥ 32 characters).
   - `TRELLO_APP_SECRET` comes from the Trello app settings for your `TRELLO_KEY`.
   - Restart `serve` after creating the groups.
6. Copy the `serve` URL and re-run the template with `PUBLIC_URL` set to that URL. (Setting it directly on
   the service would be overwritten by the next template run.)
7. Run `tools/onboard.ts --url <service url>` to register webhooks (same flags as step 3).
8. Create the Trello automation rule by hand (Automation → Rules; Trello has no API for it). The tool prints
   the rule with the placeholder `<TRIGGER_SECRET>`; replace it before saving.
9. Fill the `Settings` card and `Personal details` card on your System board (see
   [Onboarding step 4](docs/product.md)); then comment `/bot run` on a System board card.

## Web research (`company`, `deep`)

It runs only when `serve` has `CLAUDE_CODE_OAUTH_TOKEN` and the user's providers include `claude`; otherwise it
replies "unavailable" ([`researcherFor`](src/bot/stages/researcher.ts#L79)). WebFetch runs inside the `serve`
container, before the code sees any URL, so a page can make it reach an internal address, or chain a second fetch
that sends what it read elsewhere. The address check comes only after the run ([researcher.ts](src/bot/stages/researcher.ts#L140))
and decides only what is posted.

Before `serve` gets the token, deny its egress to RFC 1918 ranges, link-local (169.254.0.0/16, cloud metadata
included), loopback and the platform's internal service network. If the host offers no egress policy, keep the token
off `serve`: the bot then uses the user's other providers. With `template-local.json`, `serve` holds every key, so
this applies as soon as the token is there.

## Northflank notes

- **API token permissions** (project-scoped, not personal): Jobs › General › *Read*; *Run Job*.
  This project only; never reach `run`.
- **One worker per Northflank project.** Unrestricted groups apply to everything in the project.
- **Incidents:** check [status.northflank.com](https://status.northflank.com) if something looks wrong;
  rotate `NORTHFLANK_API_TOKEN` and all Trello credentials if an advisory recommends it.

## Without an API token

Use [`template-local.json`](deploy/northflank/template-local.json) instead of `template.json`. It creates
only the `serve` DeploymentService; without any `NORTHFLANK_*` variables, `serve` runs the scan as a child
process (the local starter). One secret group holds all keys: Trello credentials (`TRELLO_KEY`,
`TRELLO_TOKEN`), `TRELLO_APP_SECRET`, `TRIGGER_SECRET`, and all LLM keys — the service runs the scan
directly, so it needs the LLM keys too. The child process never receives `SERVICE_ONLY_ENV` variables
(`TRELLO_APP_SECRET`, `TRIGGER_SECRET`, `PUBLIC_URL`, `PORT`; `NORTHFLANK_API_TOKEN` is not set).

The service plus the scan child (and any `claude` subprocess) share the plan's RAM. Use at least 1 GB
(`SERVICE_PLAN` defaults to `nf-compute-50`); if the Sandbox restricts this to `nf-compute-20` (512 MB),
the run may fail.

## Adding a platform

- Add a folder `deploy/<name>/` with the platform's template or manifest.
- Supply the same env contract.
- Run a long-running `serve` with public HTTPS. Then either add a one-shot job API and a [`RunStarter`](src/serve/runs.ts),
  or omit the `NORTHFLANK_*` variables and let `serve` run the job as a child process (needs ≥ 1 GB RAM).

Some free LLM tiers may train on prompts; check each provider's terms before use.
