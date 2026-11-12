# Product

Each user runs their own copy of this bot. Status: built = on `main` with tests; planned (PR n) = not written yet.

## User constraints

- Free tiers only: Trello free plan, Northflank free Sandbox, the user's own LLM accounts. Some free LLM tiers may train on prompts.
- Users configure everything on Trello cards. No commits, no deploys after setup.
- One user's data, tokens and quota never pass through another user's worker or account.
- Trello free plan: 5,000 open cards per board, 250 automation runs a month, 100 API requests per 10 s.
- Old jobs are never rescored.

## User stories

- As a user I see each night's new jobs as one Trello column, best first.
- As a user I change search terms, filters, rubric or providers by editing a card; the next run uses them.
- As a user I ask `@bot` about a job card and get the answer as a comment.
- As a user I can tell why a job never got a card ([why.ts](../src/bot/why.ts)).
- As a user I see on one board whether each run worked.
- As the owner I help a friend set up their own worker without holding their data or tokens.

## Features

| Feature | Status |
|---|---|
| Job sources: career-ops portals, RSS, pages, LinkedIn | [rss](../src/pipeline/sources/rss.ts), [pages](../src/pipeline/sources/pages.ts), [linkedin](../src/pipeline/sources/linkedin.ts), [defaults](../config/defaults/), [career-ops call and scan](../src/run/scan.ts) |
| Search merged across active profiles | [search.ts](../src/pipeline/search.ts) |
| Job keys, dedup across URL variants | [keys.ts](../src/pipeline/keys.ts) |
| Title, company and text filters, each rejection with its rule | [filter.ts](../src/pipeline/filter.ts), [rules-default.json](../config/defaults/rules-default.json), [several active profiles as one](../src/run/profiles.ts), [one run's jobs: filters, descriptions, facts, cap, scoring](../src/run/process.ts) |
| Job descriptions (JSON-LD, page text) | [jd.ts](../src/pipeline/jd.ts), [html.ts](../src/pipeline/html.ts) |
| Facts extraction (language, years, licence …) and preference penalties | [facts.ts](../src/pipeline/facts.ts), [prefs.ts](../src/pipeline/prefs.ts) |
| Scoring with provider failover, pacing, clean stop on quota | [score.ts](../src/pipeline/score.ts), [llm.ts](../src/pipeline/llm.ts) |
| Masking of personal details before any prompt | [privacy.ts](../src/privacy.ts) (the only builder of the scoring context), wired into the run in [run-once.ts](../src/run/run-once.ts) |
| Job card, run column and summary card formats | [cards.ts](../src/trello/cards.ts) |
| Config cards validated (Settings, profiles, filters, caps) | [schema.ts](../src/config/schema.ts), read from Trello by [config.ts](../src/trello/config.ts); every problem reported at once with a link to its card |
| Trello client (paced, with backoff and allCards paging) | [api.ts](../src/trello/api.ts), [client.ts](../src/trello/client.ts); [key loading](../src/trello/job-index.ts) built; scope guard built; private-board check built ([private.ts](../src/trello/private.ts)) |
| Nightly run: run column, status card, `--dry-run` | [run-once.ts](../src/run/run-once.ts), CLI [run.ts](../src/run.ts) |
| `@bot` catalogue and static commands | [catalogue.ts](../src/bot/catalogue.ts) |
| Webhook service, gate, caps, `yes`/`no`, `open`/`why`/`last`/`run` | planned (PR 4) |
| Deploy template, onboarding tool | planned (PR 5) |
| Migration from samjobs | planned (PR 6) |
| Router, `needs`, `legit`, `fit`, `cv`, `feedback`, reply checks | planned (PR 7) |
| Research: `company`, `deep` | planned (PR 8) |

## Key scenarios

**Nightly run**
1. A Trello automation rule POSTs to `/trigger/run` at the user's chosen time; `serve` starts `run`.
2. `run` takes the run lock (a held lock exits without running), validates config cards, loads every job key on the Jobs board.
3. Scan, drop known keys, filter, fetch descriptions, filter again, extract facts, score up to the cap.
4. Create a column named by start time: summary card, then job cards best first.
5. Archive the cards of run columns the user archived. Write one status card, `✅` or `❌`, on top of System › Runs.
6. Jobs not scored (quota, cap) get no card and are picked up next run.

**`@bot` command**
1. The user comments `@bot <verb> [args]` or a question on any of their three boards.
2. The gate drops unsigned, foreign, repeated or non-member comments silently; over-cap ones get a one-line refusal.
3. A known verb runs its action; anything else goes to the router, which answers, asks, or picks one action.
4. Actions marked `confirm` wait 24 h for `@bot yes`. The reply is posted as a comment.

**Onboarding**
1. Fork, deploy to Northflank from the template, add secrets.
2. Run the onboarding tool: three private boards (Jobs, Profiles, System), bot added, webhooks registered.
3. Create the one Trello automation rule by hand (Trello has no API for it).
4. Fill `Settings`, `Personal details`, `CV` and one profile column; comment `@bot run` on the System board.

**Migration from samjobs** (per user, samjobs keeps running until cutover)
1. Test user with made-up profile on test boards: three clean nightly runs.
2. Shadow boards for user A, small cap, beside samjobs for 2–3 nights; compare kept jobs and scores.
3. Cutover: stop samjobs for user A, re-run the idempotent migration, raise cap, share boards, `@bot run`.
4. Repeat for user B.
