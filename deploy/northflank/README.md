# Deploy on Northflank

> Card needed in practice and an open incident (2026-11-15): see [../README.md](../README.md).

[`template.json`](template.json) creates one ManualJob (`run`) and one DeploymentService (`serve`) in your Northflank project. The `:main` tag updates on every push to `main`; Northflank pulls it on the next service restart or job run.

## Additional env vars (Northflank only)

| Variable | Job | Service |
|---|:---:|:---:|
| `NORTHFLANK_PROJECT_ID` (injected via `${args.PROJECT_ID}`) | | ✓ |
| `NORTHFLANK_JOB_ID` (injected via `${refs.job.id}`) | | ✓ |
| `NORTHFLANK_API_TOKEN` (project-scoped; restricted to `serve`) | | ✓ |

Secret groups:
- `<worker>`: `TRELLO_KEY`, `TRELLO_TOKEN` — assign to both resources
- `<worker>-llm`: LLM keys — both resources
- `<worker>-claude`: `CLAUDE_CODE_OAUTH_TOKEN` — restricted to `run`; add `serve` only for [web research](../../DEPLOY.md#web-research-company-deep)
- `<worker>-service`: `TRELLO_APP_SECRET`, `TRIGGER_SECRET`, `NORTHFLANK_API_TOKEN` — restricted to `serve`

## Steps

Before these steps, follow [DEPLOY.md steps 1–2](../../DEPLOY.md#steps) (fork and Trello boards). Then:

1. Run the template (Templates → Import JSON). Fill all no-default arguments; leave `PUBLIC_URL` empty for
   now. `serve` will fail its health check until steps 2–3 add secrets and `PUBLIC_URL` — that is expected.
2. Create the secret groups listed above.
   - Generate `TRIGGER_SECRET`: `openssl rand -hex 32` (must be ≥ 32 characters).
   - `TRELLO_APP_SECRET` comes from the Trello app settings for your `TRELLO_KEY`.
   - Each model process still gets only its own token.
   - Restart `serve` after creating the groups.
3. Copy the `serve` URL and re-run the template with `PUBLIC_URL` set to that URL. (Setting it directly on
   the service would be overwritten by the next template run.)
4. Create the Trello automation rule by hand (Automation → Rules; Trello has no API for it). `tools/onboard.ts`
   prints the rule with the placeholder `<TRIGGER_SECRET>`; replace it before saving. This rule is the nightly
   trigger for Northflank; the GitHub Actions workflow is not needed.

Then follow [DEPLOY.md steps 4 and 6](../../DEPLOY.md#steps) (step 5 sets up the GitHub nightly trigger, which Northflank does not need).

## Northflank notes

- **API token permissions** (project-scoped, not personal): Jobs › General › *Read*; *Run Job*.
  This project only; never reach `run`.
- **One worker per Northflank project.** Unrestricted groups apply to everything in the project.
- **Incidents:** check [status.northflank.com](https://status.northflank.com) if something looks wrong;
  rotate `NORTHFLANK_API_TOKEN` and all Trello credentials if an advisory recommends it.
