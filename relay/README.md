# relay

Stateless Trello webhook → `workflow_dispatch` relay ([design](../docs/superpowers/specs/2026-11-16-career-cards-gh-relay-design.md#the-relay)).
Zero runtime deps. One Web-standard core ([`src/index.ts`](src/index.ts)) runs as a Cloudflare Worker (its default
export) or under Node ([`src/node.ts`](src/node.ts), listens on `$PORT`).

Callback URL per user: `https://<relay>/hook/<owner>/<repo>/<sig>`, where `sig` is an HMAC of `owner/repo` under
`RELAY_PATH_SECRET` ([`src/sig.ts`](src/sig.ts)); a wrong or missing `sig` answers 404. Repo names are guessable, so
without it anyone could aim a Trello webhook at a user's repo and burn their Actions minutes. Each `owner/repo` also
gets at most 20 dispatches per 10 min (`drop rate`).

Logs one status word per request (`dispatch 204`, `drop ip`, `drop sig`, `fail install 404`, …), never bodies, ids,
comment text or tokens.

## Environment

| name | |
|---|---|
| `GITHUB_APP_ID` | secret |
| `GITHUB_APP_PRIVATE_KEY_PKCS8` | secret, PKCS#8 PEM (below); literal `\n` is accepted |
| `RELAY_PATH_SECRET` | secret, ≥ 32 chars (`openssl rand -base64 33`). Changing it changes every callback URL. |
| `ALLOWED_OWNERS` | comma list of GitHub owners; **set it in v1** (empty means any) |
| `RELAY_IP_HEADER` | header the host overwrites with the client IP. Default `cf-connecting-ip` (Cloudflare). **Northflank: `x-envoy-external-address`**. Required under Node. |
| `RELAY_SKIP_IP_CHECK` | `1` disables the Trello subnet check: tests only (Node refuses it unless `NODE_ENV=test`) |

Northflank [sets `X-Envoy-External-Address`](https://northflank.com/docs/v1/application/network/networking-on-northflank)
to the connecting client's IP on public HTTP/S and replaces any client value; `X-Forwarded-For` keeps client-sent entries,
so never use it. This holds only with nothing (CDN, proxy) in front of Northflank, and not for internal/VPC traffic.

## GitHub App (once)

1. Settings → Developer settings → GitHub Apps → New: any name, homepage URL, **Webhook: off**.
2. Permissions: **Repository → Actions: Read and write** only (Metadata: read is implied).
3. "Where can this app be installed": **Any account** (each user installs it on their own private repo).
4. Note the App ID; generate a private key (downloads PKCS#1 PEM). WebCrypto needs PKCS#8:
   ```sh
   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
   ```
   Store `app.pkcs8.pem` as the secret, then delete both files.

## Each user

1. The App's public page → Install → **Only select repositories** → their `career-cards-<user>` repo.
2. Add their owner to `ALLOWED_OWNERS`.
3. Their callback URL: `RELAY_PATH_SECRET=… node relay/src/hook-url.ts https://<relay> <owner>/<repo>`.

A repo without the App is remembered for 10 min, so right after installing, comments may be ignored for up to 10 min.

## Deploy

Northflank (v1): a service built from this repo with `relay/Dockerfile` (build context: repo root), public HTTP port
8080, env `PORT=8080`, `RELAY_IP_HEADER=x-envoy-external-address`, `ALLOWED_OWNERS`, and the three secrets.

Cloudflare (fallback), from `relay/`. Bundling is untested: run `npx wrangler deploy --dry-run` once first.
```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PKCS8 < app.pkcs8.pem
npx wrangler secret put RELAY_PATH_SECRET
npx wrangler deploy
```

Check: `curl -I <callback URL>` → 200.
