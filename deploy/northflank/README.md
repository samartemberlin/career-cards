# Deploy on Northflank

> **Status 2026-11-15:** The Developer Sandbox requires a default payment method in practice (409 "add a default payment method" on first deploy). A security incident from 2026-10-30 was still "Monitoring" on 2026-11-15. See [status.northflank.com](https://status.northflank.com) and compare alternatives in [../README.md](../README.md).

[`template.json`](template.json) creates one ManualJob (`run`) and one DeploymentService (`serve`) in your Northflank project.

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

1. Fork `samartemberlin/career-cards`. Make the GHCR package public (GitHub package settings → Change visibility → Public). Enable Actions first; the image is at `ghcr.io/<you>/career-cards:main`. The `:main` tag updates on every push to `main`.
2. Run `tools/onboard.ts` for the boards:
   - `--workspace <24-hex Trello workspace id>` (find it at trello.com/your-org/account → visible in the URL)
   - `--owner-user <trello-username>` (the board owner; or set `OWNER_TRELLO_KEY`/`OWNER_TRELLO_TOKEN` for a
     separate account)
   - Use `--dry-run` first to preview without creating anything.
   - `TRELLO_KEY` must be the same key the service uses: Trello signs webhooks with the app secret of the key
     that created them, so a mismatch causes every webhook to answer 401.
   - The tool prints the three board IDs; it stores them in `tools/.onboard.json`.
3. Run the template (Templates → Import JSON). Fill all no-default arguments; leave `PUBLIC_URL` empty for
   now. `serve` will fail its health check until steps 4–5 add secrets and `PUBLIC_URL` — that is expected.
4. Create the secret groups listed above.
   - Generate `TRIGGER_SECRET`: `openssl rand -hex 32` (must be ≥ 32 characters).
   - `TRELLO_APP_SECRET` comes from the Trello app settings for your `TRELLO_KEY`.
   - Each model process still gets only its own token.
   - Restart `serve` after creating the groups.
5. Copy the `serve` URL and re-run the template with `PUBLIC_URL` set to that URL. (Setting it directly on
   the service would be overwritten by the next template run.)
6. Run `tools/onboard.ts --url <service url>` to register webhooks (same flags as step 2).
7. Create the Trello automation rule by hand (Automation → Rules; Trello has no API for it). The tool prints
   the rule with the placeholder `<TRIGGER_SECRET>`; replace it before saving.
8. Fill the `Settings` card and `Personal details` card on your System board (see
   [Onboarding step 4](../../docs/product.md)); then comment `/bot run` on a System board card.

## Northflank notes

- **API token permissions** (project-scoped, not personal): Jobs › General › *Read*; *Run Job*.
  This project only; never reach `run`.
- **One worker per Northflank project.** Unrestricted groups apply to everything in the project.
- **Incidents:** check [status.northflank.com](https://status.northflank.com) if something looks wrong;
  rotate `NORTHFLANK_API_TOKEN` and all Trello credentials if an advisory recommends it.
