// A real model. Talk: a child thread has to ask its parent for the topic before writing the poem. Catch-up: a second
// agent, asked afterwards, reads the thread so far and says who showed the poem.
// Uses this machine's pi login and a few tokens; skipped without one.
// bun examples/11-real-model.js [provider/model]
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answers, api, check, done, runner, server, until, view } from './lib.js';

const model = process.argv[2] || 'openai-codex/gpt-6.1-sol';
const provider = model.split('/')[0];
let logins = {};
try { logins = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')); } catch {}
if (!logins[provider]) {
  console.log(`skip: no pi login for ${provider} on this machine (run pi, then /login)`);
  process.exit(0);
}

await server();
const home = { env: { HOME: os.homedir() } };
await runner('laptop', home);
await runner('desk', home);

const { json: { id } } = await api('POST', '/api/threads', { title: 'real' });
await api('POST', `/api/threads/${id}/entries`, {
  to: { runner: 'laptop', model },
  body: 'Start a child thread titled "poem" and ask it for a two-line poem. Don\'t tell it the topic: it has to ask you. The topic is "jujutsu version control". When the poem comes back, show it to me.',
});
const heard = await until(async () => {
  const v = await view(id);
  return v.entries.filter((e) => e.data.from && e.data.re).length >= 2 && v.status !== 'working' ? v : null;
}, 240000, 500);

const show = (v) => v.entries.map(({ id, data: m }) => `  #${id} ${m.author}${m.from ? ` [from ${m.from}${m.re ? ` re #${m.re}` : ''}]` : ''}${m.to ? ` → ${m.to.map((t) => t.runner).join(', ')}` : ''}: ${m.body.slice(0, 300)}`).join('\n');
console.log(`parent #${id}:\n${show(heard ?? await view(id))}`);
for (const t of (await api('GET', '/api/threads')).json.filter((t) => t.parent === id)) console.log(`child #${t.id}:\n${show(await view(t.id))}`);
check(Boolean(heard), 'the parent heard back twice: the question, then the poem');

const name = `${model}@laptop`;
await api('POST', `/api/threads/${id}/entries`, { to: { runner: 'desk', model }, body: 'You just joined. Which agent showed me the poem, and who asked it for one? Answer in one line, with names.' }, 'ana');
const caughtUp = (await until(async () => answers(await view(id)).find((e) => e.data.author.endsWith('@desk')), 120000, 500))?.data;
console.log(`  ${caughtUp?.author}: ${caughtUp?.body}`);
check(caughtUp?.author.endsWith('@desk') && caughtUp.body.includes(name) && caughtUp.body.toLowerCase().includes('oskar'), `the second agent read the thread: ${name} showed it, oskar asked`);

done();
