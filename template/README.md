# career-cards private repo template

Create a **private** GitHub repository from this template, then follow these steps:

## 1. Pin the career-cards SHA

Replace every `0000000000000000000000000000000000000000` in
`.github/workflows/bot.yml` and `.github/workflows/run.yml` with the same
40-character commit SHA from `samartemberlin/career-cards` that you want to
run from. The SHA appears in exactly two places per file: in `uses:` and in
the `ref:` input.

```sh
# Example — replace with the SHA you want:
SHA=1f9c4f8...  # full 40 chars
sed -i "s/0000000000000000000000000000000000000000/$SHA/g" \
  .github/workflows/bot.yml .github/workflows/run.yml
```

## 2. Add secrets

In your repo's **Settings → Secrets and variables → Actions**, add:

| Secret | Required | Description |
|--------|----------|-------------|
| `TRELLO_KEY` | Yes | Trello API key |
| `TRELLO_TOKEN` | Yes | Trello user token |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | Claude Code OAuth token (owner only) |
| `GEMINI_API_KEY` | No | Gemini API key for scoring |
| `OPENROUTER_API_KEY` | No | OpenRouter API key |
| `GROQ_API_KEY` | No | Groq API key |

## 3. Add variables

In **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Description |
|----------|-------------|
| `JOBS_BOARD_ID` | Trello jobs board id |
| `PROFILES_BOARD_ID` | Trello profiles board id |
| `SYSTEM_BOARD_ID` | Trello system board id |
| `BOT_USERNAME` | Trello bot account username |

## 4. Install the GitHub App and register the relay

Install the career-cards GitHub App on this repo, then run:

```sh
node tools/onboard.ts --relay <relay-url> --repo <owner/this-repo>
```

This registers the relay webhook and verifies the setup.

## 5. Enable nightly runs (optional)

Uncomment the `schedule:` block in `.github/workflows/run.yml`.

## Automatic re-run on crash

If the run job crashes (OOM, timeout, unhandled error) without reporting an outcome, the `retry` job in the reusable workflow re-dispatches `run.yml` once automatically.
