# Deploy

Each user runs from a **private repo** created from a public template. A shared stateless relay
([relay/README.md](relay/README.md)) forwards Trello webhooks to each user's repo via a GitHub App.

## 1. Relay operator: create GitHub App and deploy relay

Follow [relay/README.md](relay/README.md) to:
1. Create a GitHub App (Actions read/write, any account install).
2. Convert the private key to PKCS#8 and store it.
3. Deploy the relay service on Northflank (v1) or Cloudflare.

Do this once; all users share the relay.

## 2. User: create private repo from template

```sh
gh repo create career-cards-<you> --private --template samartemberlin/career-cards-template
```

Then follow [template/README.md](template/README.md) to:
- Replace the placeholder SHA in the two workflow files.
- Add secrets and variables (Trello credentials, board IDs, LLM keys).
- Install the GitHub App on the new repo.

The nightly cron in `run.yml` ships commented out; uncomment it to enable scheduled runs.

## 3. Onboard with --relay

```sh
node --env-file=<secrets-file> tools/onboard.ts \
  --relay <relay-https-base> \
  --repo <owner>/<repo> \
  [--replace-webhooks]
```

`RELAY_PATH_SECRET` must be in the env file. The tool creates the Trello boards and registers the
relay webhook; it prints the four values to add as repo **variables**:
`JOBS_BOARD_ID`, `PROFILES_BOARD_ID`, `SYSTEM_BOARD_ID`, `BOT_USERNAME`.

## 4. Start

Comment `/bot help` on any card on your boards.

## Env contract (run)

The reusable workflows inject all env from repo secrets and variables; there is nothing else to
configure. The full list is in [template/README.md](template/README.md).

## Web research (`company`, `deep`)

Runs only when `CLAUDE_CODE_OAUTH_TOKEN` is set and the user's providers include `claude`; otherwise
replies "unavailable" ([`researcherFor`](src/bot/stages/researcher.ts#L81)). The researcher fetches
pages only through [`fetch_page`](src/net/fetch-tool.ts), which refuses private addresses on every
request and redirect.

## Hosting history

The earlier hosted-service model (Render, Koyeb, Northflank) is documented in [deploy/README.md](deploy/README.md).
