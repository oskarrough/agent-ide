// A real model recalls a fact from before its compaction: a locker code planted early, then enough filler to cut it out
// of the agent's context, then a question only zoom can answer word for word. Its runner is pi's own models in this
// process, each with a 40000-token window so a compaction comes soon.
// Uses this machine's pi login and some tokens; skipped without one. Whether the model zooms is its own choice.
// bun examples/19-memory-recall-real-model.js [agent model] [memory model]
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { answered, answers, api, check, conversationOf, done, linesOf, localRunner, server, until } from './lib.js';

const model = process.argv[2] || 'openai-codex/gpt-6.1-sol';
const writer = process.argv[3] || model;
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
  return { model: { ...found.model, contextWindow: 40000 }, ...(found.thinkingLevel ? { thinkingLevel: found.thinkingLevel } : {}) };
}

const srv = await server({ MEMORY: '1', MEMORY_MODEL: `${writer}@laptop` });
await localRunner('laptop', { models, resolve, echo });
const { json: { id } } = await api('POST', '/api/threads', { title: 'recall' });
const ask = async (body, n) => {
  await api('POST', `/api/threads/${id}/entries`, { body, to: { runner: 'laptop', model } });
  return answered(id, n, 300000);
};

const prose = (topic, size) => {
  const sentence = `The ${topic} committee met again and spent the afternoon on schedules, budgets and the colour of the new signs. `;
  return sentence.repeat(Math.ceil(size / sentence.length)).slice(0, size);
};
const half = prose('building', 3000);
await api('POST', `/api/threads/${id}/entries`, { body: `${half} Note for later: the locker code is 4417. ${half}`, to: null });
await ask('Note this.', 1);
// Its line first, so the compaction's memory holds it.
await until(async () => (await linesOf(id)).some((x) => x.l === 0 && x.i === 0), 120000, 1000);
for (let k = 0; k < 25; k++) await api('POST', `/api/threads/${id}/entries`, { body: prose(`garden ${k}`, 4000), to: null });
await ask('Anything stand out?', 2);
const v = await ask('What exactly is the locker code? Zoom if your memory isn\'t word for word.', 3);

const conversation = await conversationOf(v, `${model}@laptop`);
const last = answers(v ?? { entries: [] }).at(-1)?.data.body ?? '';
console.log(`  answer: ${last.slice(0, 300)}`);
check(conversation?.entries.some((e) => e.kind === 'pi.compaction'), 'the agent\'s conversation was compacted');
check(last.includes('4417'), 'the answer has the locker code');
check(conversation?.entries.some((e) => e.kind === 'pi.assistant' && JSON.stringify(e.model ?? '').includes('"zoom"')), 'the agent zoomed', JSON.stringify(conversation?.entries.map((e) => e.kind)));

srv.kill();
done();
