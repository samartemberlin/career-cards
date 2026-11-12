// Fake for career-ops' liveness-api.mjs's checkLivenessViaApi. Called as: node api.mjs <url>
// Routes by URL suffix so tests can trigger each scenario.
const url = process.argv[2] ?? '';

if (url.endsWith('/exit1')) {
  process.exit(1);
} else if (url.endsWith('/badjson')) {
  process.stdout.write('not json\n');
} else if (url.endsWith('/env')) {
  // Print env keys so the caller can verify careerOpsEnv is applied.
  const keys = Object.keys(process.env).sort().join(',');
  process.stdout.write(JSON.stringify({ result: 'active', code: 'env_check', reason: keys }) + '\n');
} else if (url.endsWith('/active')) {
  process.stdout.write(JSON.stringify({ result: 'active', code: 'test_active', reason: 'active posting' }) + '\n');
} else if (url.endsWith('/expired')) {
  process.stdout.write(JSON.stringify({ result: 'expired', code: 'test_expired', reason: 'expired posting' }) + '\n');
} else if (url.endsWith('/uncertain')) {
  process.stdout.write(JSON.stringify({ result: 'uncertain', code: 'test_uncertain', reason: 'uncertain posting' }) + '\n');
} else {
  process.stdout.write('null\n');
}
