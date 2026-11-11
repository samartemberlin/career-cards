// Stands in for career-ops' scan.mjs: same files, same receipt shape, same exit codes.
import { appendFileSync, readFileSync } from 'node:fs';

const portals = readFileSync(process.env.CAREER_OPS_PORTALS, 'utf8');
if (portals.includes('FAKE_SCAN_EXIT=1')) {
  process.stdout.write('scanning...\nboom\n');
  process.exit(1);
}
if (portals.includes('FAKE_SCAN_HANG')) setInterval(() => {}, 1000);
else {
  const row = (status, url, title) =>
    [url, '2024-11-10', 'greenhouse-api', title, 'Acme Robotics', status, 'Berlin', '', '2024-11-08'].join('\t');
  appendFileSync(
    process.env.CAREER_OPS_SCAN_HISTORY,
    row('added', 'https://boards.greenhouse.io/acme/jobs/111', 'Data Analyst') + '\n' +
      row('skipped_dup', 'https://boards.greenhouse.io/acme/jobs/222', 'Old Role') + '\n',
  );

  const errors = [{ company: 'Gone GmbH', error: 'HTTP 404' }];
  // The env names travel as an error entry because that is the only receipt field the caller hands back.
  if (portals.includes('FAKE_REPORT_ENV')) errors.push({ company: 'fake-env', error: Object.keys(process.env).join(' ') });
  process.stdout.write('some progress line\n');
  process.stdout.write(JSON.stringify({ version: 'careerops.scan.receipt@1', added: 1, errors }) + '\n');
  process.exitCode = 2;
}
