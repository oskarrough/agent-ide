// Promise 6 at depth: a locker code said once, early in a long thread of other small facts, and a new agent asked
// for it late, with no hint to zoom. The agent's input holds the code's message only as a line high in the tree, so
// it can be found word for word only if every line above the message kept it, or the agent zooms down the right path.
// Prints which lines above the message still hold the code, then checks the answer.
// Uses this machine's pi login and many tokens: every pair of messages is merged by the writer, about N calls.
// bun examples/23-memory-deep-recall-real-model.js [agent model] [memory model] [messages, a power of two]
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { answered, answers, api, check, conversationOf, done, linesOf, localRunner, server, until } from './lib.js';

const model = process.argv[2] || 'openai-codex/gpt-6-luna';
const writer = process.argv[3] || model;
const N = Number(process.argv[4] || 1024);
const NEEDLE = 7, CODE = '4417';
let logins = {};
try { logins = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')); } catch {}
const missing = [model, writer].map((m) => m.split('/')[0]).find((p) => !logins[p]);
if (missing) {
  console.log(`skip: no pi login for ${missing} on this machine (run pi, then /login)`);
  process.exit(0);
}

const models = await ModelRuntime.create();
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.registerNativeProvider(echo.provider);
function resolve(pattern) {
  const found = resolveCliModel({ cliModel: pattern, modelRuntime: models });
  if (!found.model) throw new Error(found.error ?? `no model ${pattern}`);
  return { model: found.model, ...(found.thinkingLevel ? { thinkingLevel: found.thinkingLevel } : {}) };
}

// Each message is about 300 bytes of distinct small facts, so it is its own line and every pair needs the writer.
const teams = ['build', 'garden', 'kitchen', 'archive', 'radio', 'harbour', 'library', 'workshop'];
const fact = (k) => `${teams[k % 8]} team, ticket ${1000 + k}: moved crate ${(k * 37) % 900 + 100} from shelf ${k % 13} to bay ${(k * 7) % 31}, `
  + `logged ${(k * 11) % 60} minutes, and asked whether the ${teams[(k + 3) % 8]} rota for week ${k % 52} still stands.`;
const body = (k) => k === NEEDLE ? `${fact(k)} Also: the locker code is ${CODE}.` : fact(k);

const srv = await server({ MEMORY: '1', MEMORY_MODEL: `${writer}@laptop` });
await localRunner('laptop', { models, resolve, echo });
const { json: { id } } = await api('POST', '/api/threads', { title: 'deep recall' });
for (let k = 0; k < N; k++) await api('POST', `/api/threads/${id}/entries`, { body: body(k), to: null });
const all = await until(async () => { const ls = await linesOf(id); return ls.length === 2 * N - 1 && ls; }, 60 * 60000, 2000);
check(Boolean(all), `all ${2 * N - 1} lines are built`);

// The lines above the needle, leaf to root, and whether each still holds the code.
const above = [...Array(Math.log2(N) + 1).keys()].map((l) => all.find((x) => x.l === l && x.i === NEEDLE >> l));
for (const x of above) console.log(`  ${NEEDLE >> x.l << x.l}+${2 ** x.l}: ${x.text.includes(CODE) ? 'holds' : 'lost'} the code`);
check(above.every((x) => x.text.includes(CODE)), 'every line above the message holds the code');

await api('POST', `/api/threads/${id}/entries`, { body: 'What is the locker code?', to: { runner: 'laptop', model } });
const v = await answered(id, 1, 600000);
const last = answers(v ?? { entries: [] }).at(-1)?.data.body ?? '';
const conversation = await conversationOf(v, `${model}@laptop`);
const zooms = (conversation?.entries ?? []).filter((e) => e.kind === 'pi.assistant').flatMap((e) => JSON.stringify(e.model ?? '').match(/"zoom"/g) ?? []).length;
console.log(`  zooms: ${zooms}; answer: ${last.slice(0, 300)}`);
check(last.includes(CODE), 'the answer has the locker code');

srv.kill();
done();
