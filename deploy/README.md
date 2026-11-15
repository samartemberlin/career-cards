# Where to host a worker

A worker needs four things:
- one container from the public image;
- an HTTPS URL that Trello can reach;
- under 1 GB of RAM;
- runs of up to 60 minutes.

We want it free, and ideally without a card. The setup steps are in [DEPLOY.md](../DEPLOY.md).

The checks below were made against live docs and accounts in November 2026. Check them again before you rely on them.

| Platform | Free tier | Card | Idle behaviour | Notes | Folder |
|---|---|---|---|---|---|
| Render | 512 MB, 0.1 vCPU, 750 h/month | no | sleeps after 15 min; about 60 s to wake | **Current choice for the sample worker.** [nightly-trigger.yml](../.github/workflows/nightly-trigger.yml) keeps it awake during a run. Trello retries webhooks while it wakes. | [render/](render/) |
| Koyeb | 512 MB, 0.1 vCPU | yes, $29 pre-auth hold | scales to zero after 1 h with no traffic; under 10 s to wake | Wakes quicker than Render. The CLI name of the free instance type is unconfirmed. | [koyeb/](koyeb/) |
| Northflank | Developer Sandbox | yes in practice: docs say no card, but deploying failed on 2026-11-15 with 409 "add a default payment method" | always on | Best fit on paper: it has jobs, so the scan can run in its own container ([template.json](northflank/template.json)). Its security incident, which the status page dates from 2026-10-30, was still "Monitoring" on 2026-11-15. | [northflank/](northflank/) |
| Zeabur | free container, limits unconfirmed | no | sleeps when idle; a few seconds to wake | Untested. The $5/month credit runs out fast if the worker stays on. | — |
| Oracle Cloud Always Free | ARM VMs with plenty of RAM | yes | always on | A full VM, so it has room for a sandbox or a self-hosted model. More setup work. | — |

Ruled out: Hugging Face Spaces, where Docker now needs PRO; Fly.io and Railway, which are trial only and need a card;
Cloudflare Containers, which need the $5 plan; and Leapcell, Alwaysdata and Clever Cloud, which have no free container.

Common to every platform:
- 512 MB may be too little for an in-process scan, so watch the first run.
- The research tool fetches only public addresses ([fetch-tool.ts](../src/net/fetch-tool.ts)). Even so, an egress policy
  from the host is a useful second layer. None of the free tiers above offers one; Northflank has one only on its
  bring-your-own-cloud plans.
- A small VM (Oracle, Hetzner) is where an agent sandbox or a self-hosted scoring model would fit later.
