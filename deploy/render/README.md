# Deploy on Render

**No credit card required at signup.**  
Free tier: 512 MB RAM, 0.1 vCPU; 750 h/month.  
Idle: spins down after 15 min with no inbound HTTP; cold start ~60 s (Trello retries cover the gap for webhooks).  
Sources verified 2026-11-15: [free tier](https://render.com/docs/free) · [compute plans](https://render.com/docs/compute-plans) · [deploy image](https://render.com/docs/deploying-an-image)

## Free plan limits

Measured 2026-11-15 on the free instance (512 MB, 0.15 vCPU):

- Idle sleep: after 15 min with no inbound HTTP; cold start ~60 s. A webhook comment sent while sleeping arrived 63 s after the comment.
- **Replies and onboarding fit:** `serve` runs at ~105 MB RSS; bot replies and onboard work on the free plan.
- **Full runs do not fit:** with the heap cap from #76 (`RUN_HEAP_MB=160`), the run child stopped ~3.5 min in, right after the scan phase (container peak 435/512 MB; no container OOM, `serve` stayed up, but no Runs card was written). Without the cap, Render killed the whole instance ("exceeded its memory limit" email).
- **Conclusion:** free tier handles replies and onboarding; runs need ≥ 1 GB (upgrade to `standard` in `render.yaml`, or wait for a future memory reduction).
- No outbound egress control on Render (only SMTP ports are blocked).

To upgrade: change `plan: free` to `plan: standard` (1 vCPU, 2 GB RAM) in [`render.yaml`](render.yaml) and redeploy the Blueprint.

## Steps

1. Sign up at [render.com](https://render.com). No card needed.

2. Fork `samartemberlin/career-cards`. Make the GHCR package public (GitHub → package settings). Edit
   [`deploy/render/render.yaml`](render.yaml): change `image.url` to
   `ghcr.io/<you>/career-cards:main`.

3. Run `tools/onboard.ts` to create Trello boards:
   - `--workspace <24-hex Trello workspace id>` (find it at trello.com/your-org/account → visible in the URL)
   - `--owner-user <trello-username>` (the board owner; or set `OWNER_TRELLO_KEY`/`OWNER_TRELLO_TOKEN` for a
     separate account)
   - Use `--dry-run` first to preview without creating anything.
   - `TRELLO_KEY` must be the same key the service uses.
   - The tool prints the three board IDs; it stores them in `tools/.onboard.json`.

4. In the Render dashboard: **+ New → Blueprint** → connect your fork → set **Blueprint file path** to
   `deploy/render/render.yaml`. Fill all `sync: false` variables when prompted. Leave `PUBLIC_URL` empty.

5. After the first deploy, copy the service URL. Set `PUBLIC_URL` in the Render dashboard
   (Service → Environment → Edit → `PUBLIC_URL`).

6. Run `node tools/onboard.ts --url <URL> <flags from step 3>` to register webhooks.

7. Add `SERVE_URL=<URL>` as a GitHub repo **variable** (Settings → Variables → Actions) and
   `TRIGGER_SECRET` as a repo **secret** (Settings → Secrets → Actions) for the nightly trigger.

8. Fill the `Settings` card and `Personal details` card on your System board (see
   [Onboarding step 4](../../docs/product.md)); then comment `/bot run` on a System board card.

**Nightly-sleep risk:** Render spins down after 15 min of no inbound HTTP. Without the Keepalive step in
[`nightly-trigger.yml`](../../.github/workflows/nightly-trigger.yml), any run longer than 15 min will be
killed mid-scan. Render cron jobs are paid-tier only; use the GitHub Actions workflow instead.
