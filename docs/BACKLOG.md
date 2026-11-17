# Backlog

One list of what's left to do. To add an item, give it a short title and the user's words or the observed problem. When
one is done, delete it and name it in the PR. Start bigger items with a design note under `docs/`.

## Next (from the first user's feedback, 2026-11-17)

1. **Re-filter a run's column from its status card.**
   - **Ask:** a run wrote 253 cards into one column, which is too many. The user edits the Profiles board, then runs
     `/bot` on that run's status card to re-apply the filters to that column only.
   - **Constraints:**
     - Hidden cards must be able to come back: archive them, never delete them.
     - With looser filters, the column gets its *own* earlier cards back. It never gets new jobs.
     - The run needs to remember which jobs it posted. The card keys are already on the cards, archived ones included.
2. **Fewer cards per run.** 252 cards against the legacy limit of 60 a day. Choose between a per-run card cap (with a
   minimum score) and a lower `scoring_cap`, and show on the Runs card what was cut.
3. **Free-text bot.**
   - **Ask:** `/bot why exactly do I fit this job?` should get a real answer. Today it replies with the usage line
     "Use: why <link>".
   - **Approach:** allow free-text questions on a card, but actions still map only onto the fixed command list. The
     router already exists (`src/bot/router.ts`), so extend it rather than add a new path.
4. **Guided onboarding.** Filling in many cards up front is overwhelming; editing them later is fine.
   - Run onboarding as a Q&A, ideally a Claude Code skill: which cities, which sites to watch, what you're looking for.
   - Do the technical setup for the user: create the private repo, generate the Claude token, and set the GitHub secrets
     with `gh`.
   - Then walk the user through their Trello boards.
5. **Configurable labels.** Let the Profiles board say which labels to put on cards and in which colours: language
   requirements, the user's own wishes, and so on. Today only location and German level get labels.
6. **Multi-location jobs.** The drop list beats the keep list, so "Berlin · Munich · London" is dropped because of
   London. A job should be kept when any of its places is kept.
7. **Time budget.** The first run used 53 of 55 minutes, and facts got 13 jobs. Shorten LinkedIn's minutes, or give
   facts a reserved slice.
8. **Nightly comments on a half-filled board.** `commentOnBadCards` would comment every night. Fix this before any
   user's cron is turned on.

## Minor (none blocking)

- **Matching:**
  - `findPhrase` doesn't reject a whitespace-only phrase. The schema trims, so this can't happen today.
  - `normEmployment` "intern" also matches "interne".
  - Profile "Active" uses `startsWith`, so "yesterday" counts as active.
- **Reading:**
  - Contract types show raw enum values (`full_time`).
  - Clipping can split markdown.
  - "Example roles" are shown only on the dream card.
  - English and German levels are both shown, but only German drives penalties.
- **Bot:**
  - `/bot check` on an Originals card compiles before saying "not read".
  - `/bot why` is refused at the model cap even when the reply wouldn't count.
  - `why` cuts the CompileUnavailable message at the first ": ".
  - A model problem can name a card that doesn't exist.
- **Retry workflow:**
  - The re-run drops the run label.
  - Failures before the pipeline (bad ref, `npm ci`) also get the one retry.
  - A job that hits its timeout may end as cancelled and not retry.
- **Tests:**
  - No NFKD-ligature test.
  - No test for "all active profiles missing".
  - One loose `/bot check` assertion.
  - No injection test through the `/bot check` path.
