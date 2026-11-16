// Prints a user's Trello callback URL: RELAY_PATH_SECRET=… node relay/src/hook-url.ts <base> <owner>/<repo>
import { hookSig, MIN_SECRET, validRepo } from './sig.ts';

const [base, full] = process.argv.slice(2);
const [owner, repo, extra] = (full ?? '').split('/');
const secret = process.env.RELAY_PATH_SECRET ?? '';
if (!base || !/^https:\/\//.test(base) || !owner || !repo || extra !== undefined || !validRepo(owner, repo)) {
  console.error('usage: RELAY_PATH_SECRET=… node relay/src/hook-url.ts https://<relay> <owner>/<repo>');
  process.exit(2);
}
if (secret.length < MIN_SECRET) {
  console.error(`RELAY_PATH_SECRET must be at least ${MIN_SECRET} characters`);
  process.exit(2);
}
console.log(`${base.replace(/\/+$/, '')}/hook/${owner}/${repo}/${await hookSig(secret, owner, repo)}`);
