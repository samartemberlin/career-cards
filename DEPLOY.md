# Deploy

The documented deployment path is **Render**; see [deploy/render/README.md](deploy/render/README.md). Other options are compared in [deploy/README.md](deploy/README.md).

## Env contract

| Variable | Notes |
|---|---|
| `JOBS_BOARD_ID`, `PROFILES_BOARD_ID`, `SYSTEM_BOARD_ID` | Trello board IDs from `tools/onboard.ts` |
| `PUBLIC_URL` | HTTPS origin of the service, no trailing slash; fill after first deploy |
| `TRELLO_KEY`, `TRELLO_TOKEN` | Trello API key and token for the bot account |
| `TRELLO_APP_SECRET` | App secret for `TRELLO_KEY`; Trello signs webhooks with it — must match the key that created them |
| `TRIGGER_SECRET` | Random secret for the nightly trigger; `openssl rand -hex 32` (≥ 32 characters) |
| LLM keys: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, … | The bot builds its provider list from `serve`'s env ([`stageOpts`](src/bot/stages/handler.ts#L19)) |
| `CLAUDE_CODE_OAUTH_TOKEN` | The owner's own Claude subscription; needed for web research ([see below](#web-research-company-deep)) |
| `RUN_HEAP_MB` (optional) | V8 old-space cap (MB) of a run `serve` starts and of each of its Node children (not the `claude` CLI). Unset: 160 when the container has at most 1 GB, else none ([serve.ts](src/serve.ts)). A run over the cap ends as `run exited … (heap limit N MB reached)`, not a container kill. |

Northflank with its job API adds `NORTHFLANK_PROJECT_ID`, `NORTHFLANK_JOB_ID`, `NORTHFLANK_API_TOKEN`, and uses separate secret groups for `run` vs `serve`; see [deploy/northflank/README.md](deploy/northflank/README.md).

## Steps

1. Fork `samartemberlin/career-cards`. Make the GHCR package public (GitHub → package settings → Change visibility → Public). The image is at `ghcr.io/<you>/career-cards:main`; the `:main` tag updates on every push to `main`.
2. Run `tools/onboard.ts` to create Trello boards. Use `--dry-run` first. See [deploy/render/README.md step 3](deploy/render/README.md) for all flags.
3. Deploy to your platform; see [deploy/render/README.md](deploy/render/README.md) for Render or [deploy/README.md](deploy/README.md) for other options. Leave `PUBLIC_URL` empty on the first deploy.
4. After the first successful deploy, copy the service URL. Set `PUBLIC_URL` on the service (platform dashboard or config file). The service restarts and starts accepting traffic.
5. Run `tools/onboard.ts --url <URL>` to register Trello webhooks (same flags as step 2).
6. Set up the nightly trigger: add `SERVE_URL=<URL>` as a GitHub repo **variable** and `TRIGGER_SECRET` as a repo **secret** (Settings → Variables/Secrets → Actions). The [`nightly-trigger.yml`](.github/workflows/nightly-trigger.yml) workflow takes the place of a Trello automation rule for Render and Koyeb; see [deploy/northflank/README.md](deploy/northflank/README.md) for Northflank's Trello-based trigger.
7. Fill the `Settings` card and `Personal details` card on your System board (see [Onboarding step 4](docs/product.md)); then comment `/bot run` on a System board card.

## Web research (`company`, `deep`)

It runs only when `serve` has `CLAUDE_CODE_OAUTH_TOKEN` and the user's providers include `claude`; otherwise it
replies "unavailable" ([`researcherFor`](src/bot/stages/researcher.ts#L81)). The researcher has no WebFetch: it reads
pages only through our `fetch_page` tool ([fetch-tool.ts](src/net/fetch-tool.ts)), which uses
[safe-fetch](src/net/safe-fetch.ts) and refuses internal addresses (private ranges, loopback, link-local with cloud
metadata) before any request, on every redirect and at connect time. Its server starts with an empty environment.

A host egress policy denying `serve` those ranges is still good defence in depth.

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

Render and Koyeb always use this local-starter mode (no job API); the RAM limit applies there too.

`serve` logs `metrics: mem 412/512 MB peak 438 · oom_kill 0 · cpu thr 37% · serve 71 · run 180 · kids 3: 156 MB` (cgroup v2
and /proc) every 30 s during a local run and every 10 min when idle, after one `metrics: limits …` line at start ([metrics.ts](src/serve/metrics.ts)).

## Adding a platform

- Add a folder `deploy/<name>/` with the platform's template or manifest.
- Supply the same env contract.
- Run a long-running `serve` with public HTTPS. Then either add a one-shot job API and a [`RunStarter`](src/serve/runs.ts),
  or omit the `NORTHFLANK_*` variables and let `serve` run the job as a child process (needs ≥ 1 GB RAM).

Some free LLM tiers may train on prompts; check each provider's terms before use.

## Other platforms

Compare all options in [deploy/README.md](deploy/README.md). Per-platform setup:
[Koyeb](deploy/koyeb/README.md) · [Northflank](deploy/northflank/README.md)
