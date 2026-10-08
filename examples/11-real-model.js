// Talk with a real model: a child thread has to ask its parent for the topic before writing the poem.
// Uses this machine's pi login and a few tokens; skipped without one.
// bun examples/11-real-model.js [provider/model]
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, check, done, runner, server, until, view } from './lib.js';

const model = process.argv[2] || 'openai-codex/gpt-6.1-sol';
const provider = model.split('/')[0];
let logins = {};
try { logins = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')); } catch {}
if (!logins[provider]) {
  console.log(`skip: no pi login for ${provider} on this machine (run pi, then /login)`);
  process.exit(0);
}

await server();
await runner('laptop');

const { json: { id } } = await api('POST', '/api/threads', { title: 'real' });
await api('POST', `/api/threads/${id}/entries`, {
  to: { runner: 'laptop', model },
  body: 'Start a child thread titled "poem" and ask it for a two-line poem. Don\'t tell it the topic: it has to ask you. The topic is "jujutsu version control". When the poem comes back, show it to me.',
});
const heard = await until(async () => {
  const v = await view(id);
  return v.entries.filter((e) => e.entry.kind === 'pi.user' && e.re).length >= 2 && v.status !== 'working' ? v : null;
}, 240000, 500);

const show = (v) => v.entries.filter((e) => e.entry.kind !== 'pi.system').map((e) => {
  const c = e.entry.model?.[0]?.content;
  const text = typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? (p.type === 'toolCall' ? `[${p.name} ${JSON.stringify(p.arguments)}]` : '')).join('');
  const tag = e.from ? ` [from ${e.from}${e.re ? ` re #${e.re}` : ''}]` : '';
  return `  #${e.entry.id} ${e.author}${tag} ${e.entry.kind}: ${(text || e.entry.data?.text || '').slice(0, 300)}`;
}).join('\n');
console.log(`parent #${id}:\n${show(heard ?? await view(id))}`);
for (const t of (await api('GET', '/api/threads')).json.filter((t) => t.parent === id)) console.log(`child #${t.id}:\n${show(await view(t.id))}`);
check(Boolean(heard), 'the parent heard back twice: the question, then the poem');

done();
