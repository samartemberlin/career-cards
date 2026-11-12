# Architecture

Status marks as in [product.md](product.md).

## Components and data flow

```
Trello automation ─POST /trigger/run─┐
Trello webhook (@bot comment) ───────┴─▶ serve (always on, stateless)
                                          ├─ gate → static verb or router → stage → reply comment
                                          └─ starts ─▶ run (job, one run, then exits)
run:  lock → config cards → job keys → scan → dedup → filter → JD → filter → facts → score → run column → status card
```

| Component | Code |
|---|---|
| `serve`: webhooks, `/trigger/run`, gate, caps, job start | [serve.ts](../src/serve.ts), [app.ts](../src/serve/app.ts), [gate.ts](../src/serve/gate.ts), [dispatch.ts](../src/bot/dispatch.ts), [runs.ts](../src/serve/runs.ts), [northflank.ts](../src/serve/northflank.ts) |
| `run`: one run end to end | [run-once.ts](../src/run/run-once.ts) |
| Pipeline (ported from samjobs) | [src/pipeline/](../src/pipeline/) |
| Trello: card formats, paced client | [cards.ts](../src/trello/cards.ts), [api.ts](../src/trello/api.ts), [client.ts](../src/trello/client.ts) |
| Trello: scope guard | every Trello call is scoped to the user's three boards; writes into `Originals` throw — [scoped.ts](../src/trello/scoped.ts) |
| Trello: private-board check | boards must be private, open and have no unexpected members — [private.ts](../src/trello/private.ts) |
| Trello: card writer | job cards in score order, label resolver, JD attachment, archiving — [writer.ts](../src/trello/writer.ts) |
| Config schema, config cards reader | [schema.ts](../src/config/schema.ts), [trello/config.ts](../src/trello/config.ts) |
| Bot: action catalogue, router output schema | [catalogue.ts](../src/bot/catalogue.ts); router and stages planned (PR 7, 8) |
| Masking | [privacy.ts](../src/privacy.ts) |
| Model child process | `runModelProcess` in [llm.ts](../src/pipeline/llm.ts) |
| career-ops (scan, liveness, providers) | [career-ops/](../career-ops/) |

## Stage and security model

No stage gets untrusted content, private data and a way out at once. Stage runners: planned (PR 7, 8).

| Stage | Inputs | Tools | Private data | Network |
|---|---|---|---|---|
| router | request; conversation, card text (untrusted); masked profile; catalogue | none | masked | none |
| reader | job text (untrusted) | none | none | none |
| advisor | job text (untrusted), masked profile; for `deep`, research (untrusted) | none | masked | none |
| researcher | company, job title, posting URL, topic | web search and fetch | none | yes |
| code | the action's typed args | Trello, page fetch for `open` | as needed | `open`: posting URL only, no private addresses |

- Stage output is posted, never fed to the router or a stage with tools; the one chain is researcher → advisor (`deep`).
- `confirm` actions picked by the router run only after a human `@bot yes`.
- Replies keep only links from the card, the user's boards, or pages the stage fetched; they are masked too.
- Signed webhooks (HMAC-SHA1 of body + callback URL, constant-time); `/trigger/run` checks a secret; boards must be private.

## Decisions

- Config lives on the user's Trello cards — edits apply next run without a commit; the repo holds no user data. [schema.ts](../src/config/schema.ts)
- Memory is the key line on a card, open or archived — re-runs never duplicate, and no other state exists. [cards.ts](../src/trello/cards.ts)
- Key derivation and the `samjobs-key:` prefix are kept — migrated history keeps deduplicating. [keys.ts](../src/pipeline/keys.ts)
- No score in the description — one source of truth, visible on the board. [cards.ts](../src/trello/cards.ts)
- Every scored job gets a card, no threshold — low scores stay visible at the bottom, never lost. [process.ts](../src/run/process.ts)
- List moves and title edits are not feedback; only `@bot feedback` is — users move cards for their own tracking. [catalogue.ts](../src/bot/catalogue.ts)
- A Trello automation rule triggers the run — nothing polls, and the user edits the schedule in Trello. [app.ts](../src/serve/app.ts)
- One worker per user on their own Northflank — separation of data, tokens and quota; image stays cloud-neutral. planned (PR 5)
- One run at a time is a lock outside Trello, since no card is ever edited: a lock file locally, the platform check when deployed. [lock.ts](../src/run/lock.ts)
- Deployed, one run at a time is the service asking Northflank for active runs before starting one, serialised in one instance, with a 1 h job deadline; Northflank's concurrency policy does not cover API-started runs. [northflank.ts](../src/serve/northflank.ts)
- A broken config card fails the run before scanning, no stale fallback — the user sees the exact card. [schema.ts](../src/config/schema.ts)
- Masking with placeholders replaces samjobs' employer rewriting — users score on their own accounts; employers matter for fit. [privacy.ts](../src/privacy.ts)
- Router output is a strict zod union of catalogue ids with closed args — a forged action fails validation. [catalogue.ts](../src/bot/catalogue.ts)
- A typed `@bot <verb>` counts as confirmation — the user named the action; only router picks need `yes`. [catalogue.ts](../src/bot/catalogue.ts)
- Model calls run `claude` as a child with an explicit env, own cwd and fixed tool flags — no secret or tool leaks in. [llm.ts](../src/pipeline/llm.ts)
- No prompt-injection classifier — containment by stage capabilities is the defence. planned (PR 7)
- zod at data boundaries (config cards, model JSON) — one schema is both runtime check and type. [schema.ts](../src/config/schema.ts)
- Every Trello call in `src/` goes through `scopeUserBoards` — the guard prevents our own code (and model-driven actions) from writing to boards or lists outside the allowed scope; `src/` sees `BotApi`: create, archive, comment; no call can unarchive, edit, or add checklists or attachments to an existing card; a leaked token bypasses it entirely. [scoped.ts](../src/trello/scoped.ts), [api.ts](../src/trello/api.ts)
