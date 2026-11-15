# Deploy on Render

**No credit card required at signup.**  
Free tier: 512 MB RAM, 0.1 vCPU; 750 h/month.  
Sources verified 2026-11-15: [free tier](https://render.com/docs/free) · [compute plans](https://render.com/docs/compute-plans) · [deploy image](https://render.com/docs/deploying-an-image)

## Free plan limits

Measured 2026-11-15 on the free instance (512 MB, 0.15 vCPU per cgroup; docs say 0.1):

- Idle sleep: after 15 min with no inbound HTTP; cold start ~60 s. The webhook is held meanwhile: a reply arrived 63 s after the comment.
- **Replies and onboarding fit:** `serve` runs at ~105 MB RSS; bot replies and onboard work on the free plan.
- **Full runs do not fit:** with the heap cap from #76 (`RUN_HEAP_MB=160`), the run child stopped ~3.5 min in, right after the scan phase (container peak 435/512 MB; no container OOM, `serve` stayed up, but no Runs card was written). Without the cap, Render killed the whole instance ("exceeded its memory limit" email).
- **Conclusion:** free tier handles replies and onboarding; runs need ≥ 1 GB: set `plan: standard` (`1c-2g`, 1 vCPU, 2 GB) in [`render.yaml`](render.yaml) and redeploy the Blueprint (`starter` = `0.5c-512mb` = 512 MB, same as free and not enough), or wait for a future memory fix.
- No outbound egress control on Render (only SMTP ports are blocked).

## Steps

Before these steps, follow [DEPLOY.md steps 1–2](../../DEPLOY.md#steps) (fork and Trello boards). Then:

1. Sign up at [render.com](https://render.com). No card needed.

2. Edit [`render.yaml`](render.yaml): change `image.url` to `ghcr.io/<you>/career-cards:main`.

3. In the Render dashboard: **+ New → Blueprint** → connect your fork → set **Blueprint file path** to
   `deploy/render/render.yaml`. Fill all `sync: false` variables when prompted. Leave `PUBLIC_URL` empty —
   `serve` fails until it is set; expected.

4. Copy the service URL. Set `PUBLIC_URL` in the Render dashboard
   (Service → Environment → Edit → `PUBLIC_URL`).

Then follow [DEPLOY.md steps 4–6](../../DEPLOY.md#steps).

**Nightly-sleep risk:** Render spins down after 15 min of no inbound HTTP. Without the Keepalive step in
[`nightly-trigger.yml`](../../.github/workflows/nightly-trigger.yml), any run longer than 15 min will be
killed mid-scan. Render cron jobs are paid-tier only; use the GitHub Actions workflow instead.
