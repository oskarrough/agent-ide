// Runs every example in turn and says which failed. bun run examples
// The real-model one spends tokens on your pi login, so it only runs with REAL=1.
import { readdirSync } from 'node:fs';

const files = readdirSync(import.meta.dirname).filter((f) => /^\d\d-.*\.js$/.test(f) && (process.env.REAL || !f.includes('real-model'))).sort();
const failed = [];
for (const file of files) {
  console.log(`\n# ${file}`);
  const p = Bun.spawn(['bun', `${import.meta.dirname}/${file}`], { stdout: 'inherit', stderr: 'inherit' });
  if (await p.exited) failed.push(file);
}
console.log(failed.length ? `\n${failed.length} of ${files.length} failed: ${failed.join(', ')}` : `\nall ${files.length} ok`);
process.exit(failed.length ? 1 : 0);
