// Called by apiLiveness as a child: node src/bot/liveness-child.ts <url>
// Prints the JSON result of checkLivenessViaApi(url) on stdout and exits 0.
import { checkLivenessViaApi } from '#career-ops/liveness-api.mjs';

try {
  const url = process.argv[2] ?? '';
  process.stdout.write(JSON.stringify(await checkLivenessViaApi(url)) + '\n');
  process.exit(0);
} catch {
  process.exit(1);
}
