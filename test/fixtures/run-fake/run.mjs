// Stands in for src/run.ts in runs.test.ts.
console.log(`args ${JSON.stringify(process.argv.slice(2))}`);
console.log(`env ${JSON.stringify(Object.keys(process.env).sort())}`);
console.error('to stderr');
setTimeout(() => {}, 200);
