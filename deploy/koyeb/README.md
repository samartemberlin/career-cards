# Deploy on Koyeb

**Requires a credit card at signup** ($29 pre-auth hold, cancelled immediately).  
Free tier: 512 MB RAM, 0.1 vCPU; one free service; Frankfurt (`fra`) or DC (`was`).  
Idle: scales to zero after 1 hour with no inbound traffic; cold start: typically &lt;10 s.  
Sources verified 2026-11-15: [pricing FAQ](https://www.koyeb.com/docs/faqs/pricing) · [instances](https://www.koyeb.com/docs/reference/instances)

**RAM note:** `serve` runs the scan as a child process (local starter). Both share the 512 MB free limit.
A run may OOM. Upgrade to `eco-small` (eco, 1 GB) or `small` (standard, 1 GB) if it does.

**Nightly-sleep risk:** The free instance scales to zero after 1 h with no inbound traffic. The workflow
[`nightly-trigger.yml`](../../.github/workflows/nightly-trigger.yml) polls `/healthz` every 10 min during the
run to prevent this. Use the GitHub Actions workflow as the nightly trigger instead of a Trello
automation rule — a Trello-triggered run gets no keepalive and would be killed by idle-sleep.

**First deploy:** The service starts with `PUBLIC_URL` empty, which causes it to crash on startup
(PUBLIC_URL is required). Get the service URL from the dashboard, fill it in step 5, and the service
starts on the next deployment.

## Steps

1. Sign up at [koyeb.com](https://koyeb.com). Install the CLI and log in:
   ```sh
   curl https://raw.githubusercontent.com/koyeb/koyeb-cli/main/install.sh | bash
   koyeb login
   ```

2. Run `tools/onboard.ts` to create Trello boards (see [deploy/render/README.md](../render/README.md) step 3 for flags). Use `--dry-run` first. Store the board IDs:
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

6. Run `node tools/onboard.ts --url <URL> <flags from step 2>` to register webhooks.

7. Add `SERVE_URL=<URL>` as a GitHub repo **variable** (Settings → Variables → Actions) and
   `TRIGGER_SECRET` as a repo **secret** (Settings → Secrets → Actions) for the nightly trigger.

8. Fill the `Settings` card and `Personal details` card on your System board (see
   [Onboarding step 4](../../docs/product.md)); then comment `/bot run` on a System board card.
