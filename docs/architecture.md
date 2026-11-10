# Architecture

Status marks as in [product.md](product.md).

## Components and data flow

```
Trello automation ─POST /trigger/run─┐
Trello webhook (@bot comment) ───────┴─▶ serve (always on, stateless)
                                          ├─ gate → static verb or router → stage → reply comment
                                          └─ starts ─▶ run (job, one run, then exits)
run:  config cards → job keys → scan → dedup → filter → JD → filter → facts → score → run column → status card
```

| Component | Code |
|---|---|
| `serve`: webhooks, `/trigger/run`, gate, caps, job start | planned (PR 4) |
| `run`: one run end to end | planned (PR 3) |
| Pipeline (ported from samjobs) | [src/pipeline/](../src/pipeline/) |
| Trello: card formats | [cards.ts](../src/trello/cards.ts); client and fake board planned (PR 2) |
| Config schema | [schema.ts](../src/config/schema.ts) |
| Bot: action catalogue, router output schema | [catalogue.ts](../src/bot/catalogue.ts); router and stages planned (PR 7, 8) |
| Masking | [privacy.ts](../src/privacy.ts) |
| Model child process | `runModelProcess` in [llm.ts](../src/pipeline/llm.ts) |
| career-ops (scan, liveness, providers) | [career-ops/](../career-ops/) |

## Stage and security model

No stage gets untrusted content, private data and a way out at once. Stages are declared per action in
[catalogue.ts](../src/bot/catalogue.ts); their runners are planned (PR 7, 8).

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

- Trello is the database and the UI — config edits apply next run without a commit; the repo holds no user data. [schema.ts](../src/config/schema.ts)
- Memory is the key line on a card, open or archived — re-runs never duplicate, and no other state exists. [cards.ts](../src/trello/cards.ts)
- Readers also accept `samjobs-key:` and keys derive as in samjobs — migrated history keeps matching. [keys.ts](../src/pipeline/keys.ts)
- The score lives only in the title — one source of truth. [cards.ts](../src/trello/cards.ts)
- Every scored job gets a card, no threshold — low scores stay visible at the bottom, never lost. planned (PR 3)
- List moves and title edits are not feedback; only `@bot feedback` is — users move cards for their own tracking. [catalogue.ts](../src/bot/catalogue.ts)
- A Trello automation rule triggers the run — nothing polls, and the user edits the schedule in Trello. planned (PR 4)
- One worker per user on their own Northflank — separation of data, tokens and quota; image stays cloud-neutral. planned (PR 5)
- A broken config card fails the run before scanning, no stale fallback — the user sees the exact card. [schema.ts](../src/config/schema.ts)
- Masking with placeholders replaces samjobs' employer rewriting — users score on their own accounts; employers matter for fit. [privacy.ts](../src/privacy.ts)
- Router output is a strict zod union of catalogue ids with closed args — a forged action fails validation. [catalogue.ts](../src/bot/catalogue.ts)
- A typed `@bot <verb>` counts as confirmation — the user named the action; only router picks need `yes`. [catalogue.ts](../src/bot/catalogue.ts)
- Model calls run `claude` as a child with an explicit env, own cwd and fixed tool flags — no secret or tool leaks in. [llm.ts](../src/pipeline/llm.ts)
- No prompt-injection classifier — containment by stage capabilities is the defence. planned (PR 7)
- TypeScript by type stripping, zod at data boundaries — mechanical port, no build; one schema is check and type. [package.json](../package.json)
