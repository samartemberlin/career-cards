# career-cards

A personal job-search bot: [career-ops](https://github.com/santifer/career-ops) scans job sources, a cheap LLM scores
new jobs, and every result lands as a card on the user's own Trello boards. Trello is the database and the UI; each user
deploys their own worker from a fork, with their own tokens. Status: under construction.

## Quick start

Requires Node 24.

```sh
npm ci
npm test
```

See [`docs/`](docs/) for architecture and configuration.
