// Stands in for career-ops' fetch-jd.mjs: answers with the names of the env vars it was given, long enough to count as a JD.
process.stdout.write(`${Object.keys(process.env).join(' ')} ${'.'.repeat(300)}\n`);
