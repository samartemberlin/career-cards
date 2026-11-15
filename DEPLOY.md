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
| `RUN_HEAP_MB` (optional): V8 old-space cap (MB) of a run `serve` starts itself and of each of its node children (not the `claude` CLI). Unset: 160 when the container has at most 1 GB, else none ([serve.ts](src/serve.ts)); if the `metrics: limits` line shows no `mem … MB`, set it yourself on a small host. A run over it ends as `run exited … (heap limit N MB reached)`, not a container kill. Measured without scoring (dummy AI keys): uncapped, a 512 MB / 0.15 vCPU container was OOM-killed; capped, it peaked at 375 MB | | ✓ |

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
replies "unavailable" ([`researcherFor`](src/bot/stages/researcher.ts#L81)). The researcher has no WebFetch: it reads
pages only through our `fetch_page` tool ([fetch-tool.ts](src/net/fetch-tool.ts)), which uses
[safe-fetch](src/net/safe-fetch.ts) and refuses internal addresses (private ranges, loopback, link-local with cloud
metadata) before any request, on every redirect and at connect time. Its server starts with an empty environment.

A host egress policy denying `serve` those ranges is still good defence in depth.

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

`serve` logs `metrics: mem 412/512 MB peak 438 · oom_kill 0 · cpu thr 37% · serve 71 · run 180 · kids 3: 156 MB` (cgroup v2
and /proc) every 30 s during a local run and every 10 min when idle, after one `metrics: limits …` line at start ([metrics.ts](src/serve/metrics.ts)).

## Koyeb

**Requires a credit card at signup** ($29 pre-auth hold, cancelled immediately).  
Free tier: 512 MB RAM, 0.1 vCPU; one free service; Frankfurt (`fra`) or DC (`was`).  
Idle: scales to zero after 1 hour with no inbound traffic; cold start: typically &lt;10 s.  
Sources verified 2026-11-15: [pricing FAQ](https://www.koyeb.com/docs/faqs/pricing) · [instances](https://www.koyeb.com/docs/reference/instances)

**RAM note:** `serve` runs the scan as a child process (local starter). Both share the 512 MB free limit.
A run may OOM. Upgrade to `eco-small` (eco, 1 GB) or `small` (standard, 1 GB) if it does.

**Nightly-sleep risk:** The free instance scales to zero after 1 h with no inbound traffic. The workflow
[`nightly-trigger.yml`](.github/workflows/nightly-trigger.yml) polls `/healthz` every 10 min during the
run to prevent this. Use the GitHub Actions workflow as the nightly trigger instead of a Trello
automation rule — a Trello-triggered run gets no keepalive and would be killed by idle-sleep.

**First deploy:** The service starts with `PUBLIC_URL` empty, which causes it to crash on startup
(PUBLIC_URL is required). Get the service URL from the dashboard, fill it in step 5, and the service
starts on the next deployment — the same pattern as the Northflank setup.

1. Sign up at [koyeb.com](https://koyeb.com). Install the CLI and log in:
   ```sh
   curl https://raw.githubusercontent.com/koyeb/koyeb-cli/main/install.sh | bash
   koyeb login
   ```

2. Save a local env file (chmod 600) with your board IDs from `tools/.onboard.json`:
   ```sh
   mkdir -p ~/.config/career-cards
   cat > ~/.config/career-cards/koyeb.env <<'EOF'
   JOBS_BOARD_ID=<from onboard.ts>
   PROFILES_BOARD_ID=<from onboard.ts>
   SYSTEM_BOARD_ID=<from onboard.ts>
   EOF
   chmod 600 ~/.config/career-cards/koyeb.env
   ```

3. Create Koyeb secrets (paste value then Ctrl-D; skip any provider key you don't use):
   ```sh
   koyeb secrets create TRELLO_KEY
   koyeb secrets create TRELLO_TOKEN
   koyeb secrets create TRELLO_APP_SECRET
   koyeb secrets create TRIGGER_SECRET   # openssl rand -hex 32
   koyeb secrets create GEMINI_API_KEY
   koyeb secrets create OPENROUTER_API_KEY
   koyeb secrets create GROQ_API_KEY
   ```

4. Create the service (references secrets by name; no values in shell history):
   ```sh
   source ~/.config/career-cards/koyeb.env
   bash deploy/koyeb/create.sh
   ```

5. Copy the service URL from [app.koyeb.com](https://app.koyeb.com). Fill `PUBLIC_URL`:
   ```sh
   koyeb services update serve --app career-cards-worker --env PUBLIC_URL=<URL>
   ```

6. Run `node tools/onboard.ts --url <URL> <flags from step 3 of Northflank setup>`.
   Skip step 8 of that setup (Trello automation rule) — the GitHub Actions workflow takes its place.

7. Add `SERVE_URL=<URL>` as a GitHub repo **variable** (Settings → Variables → Actions) and
   `TRIGGER_SECRET` as a repo **secret** (Settings → Secrets → Actions) for the nightly trigger.

## Render

**No credit card required at signup.**  
Free tier: 512 MB RAM, 0.1 vCPU; 750 h/month.  
Idle: spins down after 15 min with no inbound HTTP; cold start ~60 s (Trello retries cover the gap for webhooks).  
Sources verified 2026-11-15: [free tier](https://render.com/docs/free) · [compute plans](https://render.com/docs/compute-plans) · [deploy image](https://render.com/docs/deploying-an-image)

**RAM note:** same as Koyeb — in-process scan shares 512 MB. Upgrade to `standard` (`1c-2g`, 1 vCPU,
2 GB) in [`deploy/render/render.yaml`](deploy/render/render.yaml) if runs OOM. (`starter` = `0.5c-512mb`
= 512 MB — same RAM as free and not enough.)

**Nightly-sleep risk:** Render spins down after 15 min of no inbound HTTP. Without the Keepalive step in
[`nightly-trigger.yml`](.github/workflows/nightly-trigger.yml), any run longer than 15 min will be killed
mid-scan. Render cron jobs are paid-tier only; use the GitHub Actions workflow instead.

**First deploy:** The service starts with `PUBLIC_URL` empty, which causes it to crash on startup
(PUBLIC_URL is required). The Blueprint prompts for it; leave it blank. After the first deploy, copy
the URL and set it in the Render dashboard — the service starts accepting traffic on the next restart.

1. Sign up at [render.com](https://render.com). No card needed.

2. Fork `samartemberlin/career-cards`. Make the GHCR package public (GitHub → package settings). Edit
   [`deploy/render/render.yaml`](deploy/render/render.yaml): change `image.url` to
   `ghcr.io/<you>/career-cards:main`.

3. In the Render dashboard: **+ New → Blueprint** → connect your fork → set **Blueprint file path** to
   `deploy/render/render.yaml`. Fill all `sync: false` variables when prompted. Leave `PUBLIC_URL` empty.

4. After the first deploy, copy the service URL. Set `PUBLIC_URL` in the Render dashboard
   (Service → Environment → Edit → `PUBLIC_URL`).

5. Run `node tools/onboard.ts --url <URL> <flags>`.
   Skip step 8 of the Northflank setup (Trello automation rule) — the GitHub Actions workflow takes its place.

6. Add `SERVE_URL=<URL>` as a GitHub repo **variable** (Settings → Variables → Actions) and
   `TRIGGER_SECRET` as a repo **secret** (Settings → Secrets → Actions) for the nightly trigger.

## Adding a platform

- Add a folder `deploy/<name>/` with the platform's template or manifest.
- Supply the same env contract.
- Run a long-running `serve` with public HTTPS. Then either add a one-shot job API and a [`RunStarter`](src/serve/runs.ts),
  or omit the `NORTHFLANK_*` variables and let `serve` run the job as a child process (needs ≥ 1 GB RAM).

Some free LLM tiers may train on prompts; check each provider's terms before use.
