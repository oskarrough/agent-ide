// Does memory keep promise 6 on a real thread? One replayed pi session, the same agent asked along the way, then each
// question asked once in a fork of its own, under four setups:
//   full     everything in context (the ceiling)
//   pi       Pi's own compaction, no memory (today's baseline)
//   tree     memory's lines and zoom
//   search   the same lines, and `threads` with a `query`
// An answer counts when it contains the expected text, ignoring case: no model judges. Prints recall by kind and by age,
// tool calls and tokens per question, how many lines the writer wrote, and how high in the tree each answer survives.
// The questions are a JSON list of {q, a: text | [texts], kind: gist | detail | superseded, at: the index of the post
// that holds the answer in the replayed session}.
// Uses the provider's API key or pi login. With echo/echo as both models it costs nothing and only tests the plumbing.
// bun examples/25-memory-eval-real-model.js <session.jsonl | folder> <questions.json> [agent model] [memory model] [--limit N] [--window T] [--every K]
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { postable, sessionPosts } from '../scripts/replay-pi.js';
import { answered, answers, api, check, db, done, linesOf, localRunner, server, until, view } from './lib.js';

const { values: opts, positionals: [source, questionsFile, model = 'openrouter/z-ai/glm-5.3-flash', writer = model] } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: 'string', default: '300' }, window: { type: 'string', default: '100000' }, every: { type: 'string', default: '30' } },
});
if (!source || !questionsFile) {
  console.log('skip: give a pi session and its questions (see the top of this file)');
  process.exit(0);
}
let logins = {};
try { logins = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')); } catch {}
const missing = [model, writer].map((m) => m.split('/')[0]).find((p) => p !== 'echo' && !logins[p] && !process.env[`${p.toUpperCase().replace(/-/g, '_')}_API_KEY`]);
if (missing) {
  console.log(`skip: no pi login for ${missing} on this machine (run pi, then /login, or set its API key)`);
  process.exit(0);
}

const posts = sessionPosts(source).posts.slice(0, Number(opts.limit));
const questions = JSON.parse(readFileSync(questionsFile, 'utf8'));
const N = posts.length, WINDOW = Number(opts.window), EVERY = Number(opts.every);
const agent = { runner: 'laptop', model };
const agentName = `${model}@laptop`;
const expected = (q) => [q.a].flat().map((a) => a.toLowerCase());
const holds = (text, q) => expected(q).some((a) => text.toLowerCase().includes(a));

const models = await ModelRuntime.create();
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] });
models.registerNativeProvider(echo.provider);
// `window` tokens for every model but the ceiling's, so a long thread compacts.
const resolver = (window) => (pattern) => {
  const found = resolveCliModel({ cliModel: pattern, modelRuntime: models });
  if (!found.model) throw new Error(found.error ?? `no model ${pattern}`);
  return { model: window ? { ...found.model, contextWindow: window } : found.model, ...(found.thinkingLevel ? { thinkingLevel: found.thinkingLevel } : {}) };
};

const setups = {
  full: { env: { MEMORY: '0', TALK: '0' }, window: 0 },
  pi: { env: { MEMORY: '0', TALK: '0' }, window: WINDOW },
  tree: { env: { MEMORY: '1', TALK: '0' }, window: WINDOW },
  // The same thread and lines as tree, only asked with `threads` on.
  search: { env: { MEMORY: '1', TALK: '1' }, window: WINDOW, from: 'tree' },
};
const store = (name) => path.join(path.dirname(db), `${name}.sqlite`);
const start = async (name) => {
  const { env, window } = setups[name];
  const srv = await server({ ...env, MEMORY_MODEL: `${writer}@laptop`, DB_PATH: store(setups[name].from ?? name) });
  const runner = await localRunner('laptop', { models, resolve: resolver(window), echo });
  return { stop: async () => { runner.close(); srv.kill(); await new Promise((r) => srv.once('exit', r)); } };
};

// The thread as it was lived: each post as its author, and the agent asked to note them every EVERY posts and at the end.
async function build(name) {
  const run = await start(name);
  const { json: { id } } = await api('POST', '/api/threads', { title: `eval ${name}` });
  let asked = 0;
  for (const [k, { author, body }] of posts.entries()) {
    await api('POST', `/api/threads/${id}/entries`, { body: postable(body), to: null }, author);
    if ((k + 1) % EVERY && k + 1 < N) continue;
    await api('POST', `/api/threads/${id}/entries`, { body: 'Noted? Answer just: ok', to: agent });
    if (!await answered(id, ++asked, 600000)) throw new Error(`${name}: no answer to check-in ${asked}`);
  }
  if (setups[name].env.MEMORY === '1') {
    const T = (await view(id)).entries.length;
    const want = [...Array(Math.ceil(Math.log2(T)) + 1).keys()].reduce((s, l) => s + Math.floor(T / 2 ** l), 0);
    if (!await until(async () => (await linesOf(id)).length >= want, 60 * 60000, 2000)) throw new Error(`${name}: lines not built`);
  }
  await run.stop();
  return id;
}

// Each question in a fork at the thread's last entry, so no question sees another's answer.
async function ask(name, id) {
  const run = await start(name);
  const last = (await view(id)).entries.at(-1).id;
  const rows = [];
  for (const q of questions) {
    const { json: { id: fork } } = await api('POST', `/api/threads/${id}/fork`, { at: last, title: `${name}: ${q.q.slice(0, 40)}` });
    await api('POST', `/api/threads/${fork}/entries`, { body: q.q, to: agent });
    const v = await answered(fork, (await answers(await view(fork))).length + 1, 600000);
    const body = answers(v ?? { entries: [] }).at(-1)?.data.body ?? '';
    const conversation = (await api('GET', `/api/conversations/${v?.agents.find((a) => a.name === agentName)?.conversation}`)).json;
    const asked = conversation.entries?.findLastIndex((e) => e.kind === 'agent-ide.delivery') ?? -1;
    const tools = conversation.entries?.slice(asked).filter((e) => e.kind === 'pi.tool-result').length ?? 0;
    rows.push({ ...q, setup: name, answer: body, ok: holds(body, q), tools, usage: conversation.docs?.['pi.usage'] });
  }
  await run.stop();
  return rows;
}

const ids = {};
for (const name of ['full', 'pi', 'tree']) ids[name] = await build(name);
ids.search = ids.tree;
const rows = [];
for (const name of Object.keys(setups)) rows.push(...await ask(name, ids[name]));

// How high above its message each answer survives in the lines, and how many lines the writer wrote.
const run = await start('tree');
const lines = await linesOf(ids.tree);
const messages = (await view(ids.tree)).entries;
await run.stop();
const line = (l, i) => lines.find((x) => x.l === l && x.i === i);
// A post's position in the thread, after the check-in and its answer that follow every EVERY posts.
const position = (k) => k + 2 * Math.floor(k / EVERY);
const survives = (q) => { const p = position(q.at); let l = 0; while (line(l, p >> l) && holds(line(l, p >> l).text, q)) l++; return l - 1; };
const said = (e) => `${e.data.author}: ${e.data.body}`;
const written = lines.filter((x) => x.l ? Buffer.byteLength(`${line(x.l - 1, 2 * x.i)?.text} ${line(x.l - 1, 2 * x.i + 1)?.text}`) > 512 : Buffer.byteLength(said(messages[x.i])) > 512).length;

const recall = (list) => list.length ? `${Math.round(100 * list.filter((r) => r.ok).length / list.length)}%` : '-';
const age = (q) => q.at < N / 3 ? 'old' : q.at < 2 * N / 3 ? 'middle' : 'recent';
const spent = (r) => Object.values(r.usage?.models ?? {});
const tokens = (r) => spent(r).reduce((s, u) => s + u.input + u.output, 0);
const dollars = (r) => spent(r).reduce((s, u) => s + (u.cost?.total ?? 0), 0);
console.log(`\n${N} posts, ${questions.length} questions, agent ${model}, writer ${writer}, window ${WINDOW}, ${lines.length} lines, ${written} written by the writer`);
console.log(['setup', 'all', 'gist', 'detail', 'superseded', 'old', 'middle', 'recent', 'tools/q', 'tokens/q', '$ all'].join('\t'));
const by = {};
for (const name of Object.keys(setups)) {
  const mine = rows.filter((r) => r.setup === name);
  by[name] = mine;
  const kinds = ['gist', 'detail', 'superseded'].map((k) => recall(mine.filter((r) => r.kind === k)));
  const ages = ['old', 'middle', 'recent'].map((a) => recall(mine.filter((r) => age(r) === a)));
  const per = (f) => Math.round(mine.reduce((s, r) => s + f(r), 0) / mine.length);
  console.log([name, recall(mine), ...kinds, ...ages, per((r) => r.tools), per(tokens), mine.reduce((s, r) => s + dollars(r), 0).toFixed(3)].join('\t'));
}
console.log('\nsurvival: how many levels above its message each answer is still in the lines (-1: lost in its own line)');
for (const q of questions) console.log(`  ${String(survives(q)).padStart(2)}  ${q.kind}  @${q.at}  ${q.q.slice(0, 70)}`);
const out = `${questionsFile.replace(/\.json$/, '')}.results.json`;
writeFileSync(out, JSON.stringify({ model, writer, window: WINDOW, every: EVERY, posts: N, lines: lines.length, written, rows }, null, 2));
console.log(`\nevery answer in ${out}`);

const share = (name, f = () => true) => { const l = by[name].filter(f); return l.filter((r) => r.ok).length / (l.length || 1); };
check(share('tree') > share('pi'), 'memory recalls more than Pi\'s own compaction', `${recall(by.tree)} vs ${recall(by.pi)}`);
check(share('search', (r) => r.kind === 'detail') >= share('tree', (r) => r.kind === 'detail'), 'searching recalls at least the details the tree does', `${recall(by.search.filter((r) => r.kind === 'detail'))} vs ${recall(by.tree.filter((r) => r.kind === 'detail'))}`);
check(share('search') >= share('full') - 0.1, 'memory with search comes within 10 points of everything in context', `${recall(by.search)} vs ${recall(by.full)}`);
done();
