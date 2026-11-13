// Stands in for career-ops' discover-ats.mjs: reads `--in`, prints the same JSON shape. The caller passes no
// FAKE_* variable through (career-ops gets PATH, HOME and LANG only), so the record goes to $HOME/discover-record.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const args = process.argv.slice(2);
const parsed = load(readFileSync(args[args.indexOf('--in') + 1], 'utf8'));
writeFileSync(join(process.env.HOME, 'discover-record.json'), JSON.stringify({
  argv: process.argv.slice(1).map((a, i) => (i === 0 ? a.split('/').pop() : a)),
  env: Object.keys(process.env),
  portals: readFileSync(process.env.CAREER_OPS_PORTALS, 'utf8'),
  input: parsed,
}));

const name = parsed?.companies?.[0]?.name ?? '';
if (name === 'Broken Board') {
  process.stderr.write('discover-ats: probe crashed\n');
  process.exit(1);
}
const resolved = name === 'Acme Robotics'
  ? [{ name, vendor: 'gh', slug: 'acme-robotics', careers_url: 'https://job-boards.greenhouse.io/acme-robotics', jobCount: 12,
      api: 'https://boards-api.greenhouse.io/v1/boards/acme-robotics/jobs' }]
  : [];
const unresolved = resolved.length ? [] : [{ name, triedVendors: ['gh', 'ashby', 'lever'], reason: 'no supported ATS board found.' }];
console.log(JSON.stringify({
  metadata: { resolved: resolved.length, unresolved: unresolved.length, written: false, previewOnly: true, warnings: [] },
  resolved, unresolved, pendingEntries: '',
}, null, 2));
