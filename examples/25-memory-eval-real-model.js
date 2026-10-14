// Does memory keep promise 6 on a long thread? A made-up team thread, the same every run, with facts planted at known
// posts; the agent asked along the way, then each question asked once in a fork of its own, under four setups:
//   full     everything in context (the ceiling)
//   pi       Pi's own compaction, no memory (today's baseline)
//   tree     memory's lines and zoom
//   search   the same lines, and `threads` with a `query`
// Questions are of three kinds: a detail said once inside chatter, a fact said and later changed (the newest counts),
// and the gist of a stretch where one subject came up again and again. An answer counts when it contains the expected
// text, ignoring case: no model judges. Prints recall by kind and by age, tool calls, tokens and dollars per question,
// how many lines the writer wrote, and how high in the tree each answer survives.
// At the defaults it makes about 500 model calls, about 300 of them the writer's. With echo/echo as both models it
// costs nothing and only tests the plumbing.
// bun examples/25-memory-eval-real-model.js [agent model] [memory model] [--posts N] [--window T] [--every K] [--out F]
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { answered, answers, api, check, db, done, linesOf, localRunner, server, until, view } from './lib.js';

const { values: opts, positionals: [model = 'openrouter/z-ai/glm-5.3-flash', writer = model] } = parseArgs({
  allowPositionals: true,
  options: {
    posts: { type: 'string', default: '240' },
    window: { type: 'string', default: '24000' },
    every: { type: 'string', default: '15' },
    out: { type: 'string', default: path.join(os.tmpdir(), 'memory-eval.json') },
  },
});
let logins = {};
try { logins = JSON.parse(readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8')); } catch {}
const missing = [model, writer].map((m) => m.split('/')[0]).find((p) => p !== 'echo' && !logins[p] && !process.env[`${p.toUpperCase().replace(/-/g, '_')}_API_KEY`]);
if (missing) {
  console.log(`skip: no pi login for ${missing} on this machine (run pi, then /login, or set its API key)`);
  process.exit(0);
}

// [where, as a share of the thread; what is said; the question; its answer]
const details = [
  [0.04, 'The door code for the storage room is 4417, by the way.', 'What is the door code for the storage room?', '4417'],
  [0.12, 'Staging now runs on the box called heron-7.', 'What is the staging server called?', 'heron-7'],
  [0.21, 'The CSV export bug is filed as BUG-2291.', 'Which ticket is the CSV export bug filed as?', 'BUG-2291'],
  [0.30, 'We went with Fraunces for the headings.', 'Which font did we pick for headings?', 'Fraunces'],
  [0.38, 'Our accountant is called Halvorsen, if anyone needs to reach them.', "What is our accountant's name?", 'Halvorsen'],
  [0.46, 'Backups go to the bucket cold-archive-31.', 'Which bucket do backups go to?', 'cold-archive-31'],
  [0.55, 'The printer on the second floor is named Gutenberg.', 'What is the second-floor printer named?', 'Gutenberg'],
  [0.63, 'Guests should use the network lighthouse-guest.', 'Which network should guests use?', 'lighthouse-guest'],
  [0.72, 'The overdue one is invoice INV-0457.', 'Which invoice is overdue?', 'INV-0457'],
  [0.81, 'The demo video runs 4:12 in the final cut.', 'How long is the final cut of the demo video?', '4:12'],
  [0.89, 'The office cat has a name now: Pixel.', 'What is the office cat called?', 'Pixel'],
  [0.96, 'The vendor quoted 3,850 euros for the hardware.', 'How much did the vendor quote for the hardware?', ['3,850', '3850', '3 850']],
];
// [where it was said; where it changed; what was said; what changed it; the question; the newest answer]
const changes = [
  [0.02, 0.12, 'Launch is set for March 3.', 'Launch moves to April 14, March 3 is off.', 'When is the launch?', 'April 14'],
  [0.08, 0.20, 'The offsite will be in Porto.', 'Change of plan: the offsite is in Tallinn, not Porto.', 'Where is the offsite?', 'Tallinn'],
  [0.15, 0.30, 'We store everything in Postgres for now.', 'We are moving storage from Postgres to SQLite.', 'Which database do we store everything in?', 'SQLite'],
  [0.25, 0.45, 'A seat costs $12 a month.', 'New pricing: $9 a seat per month.', 'How much does a seat cost per month?', ['$9', '9 dollars', '9 usd']],
  [0.35, 0.92, 'The project codename is Bramble.', 'We are renaming the codename from Bramble to Kestrel.', 'What is the project codename?', 'Kestrel'],
  [0.42, 0.60, 'On-call handover happens on Tuesday.', 'On-call handover is Thursday from now on.', 'Which day is the on-call handover?', 'Thursday'],
  [0.50, 0.97, 'The logo color is teal.', 'Final decision: the logo goes ochre instead of teal.', 'What color is the logo?', 'ochre'],
  [0.58, 0.78, 'Uploads are capped at 25 MB.', 'We raised the upload cap from 25 MB to 40 MB.', 'What is the upload size cap?', ['40 MB', '40MB']],
  [0.65, 0.86, 'Planning is in Room Ada.', 'Planning moves to Room Hopper; Ada is booked.', 'Which room is planning in?', 'Hopper'],
];
// [where the stretch starts; what is said in it, every other post; the question; its answer]
const gists = [
  [0.05, ['Should we support offline mode at all?', 'Offline mode means sync conflicts, which scares me.', 'Users on trains keep asking for offline use.', 'If we do offline, the cache has to be versioned.', 'I sketched how offline edits would merge.', 'Offline adds a week at least.', 'Okay, offline goes in, read-only first.', 'Offline read-only works in the prototype.'], 'Early on we debated supporting one mode for days. Which mode?', 'offline'],
  [0.17, ['Norrland Freight emailed again about late tracking emails.', 'Norrland says the tracking links expire too soon.', 'I called Norrland Freight to apologise.', 'Norrland wants a refund for last month.', 'We gave Norrland a month free.', 'Norrland Freight confirmed the links work now.', 'Norrland asked for a CSV of their shipments.', 'Norrland is happy, closing it with them.'], 'Which customer had a long saga with us?', 'Norrland'],
  [0.28, ['Webpack builds take four minutes, can we try esbuild?', 'esbuild builds the app in two seconds here.', 'esbuild does not handle our SVG imports yet.', 'Wrote an esbuild plugin for the SVGs.', 'Moving CI to esbuild too.', 'esbuild is in, Webpack config deleted.', 'esbuild sourcemaps look right.', 'Nobody misses Webpack since esbuild.'], 'Which build tool did we switch to?', 'esbuild'],
  [0.40, ['The payments tests failed again on CI.', 'Payments tests pass locally, fail on CI.', 'I think the payments tests depend on the clock.', 'Pinned the time in the payments tests.', 'Payments tests flaked once more overnight.', 'Found it: the payments tests share a database row.', 'Payments tests isolated, green ten runs in a row.', 'Closing the payments flake hunt.'], 'Tests kept failing at random for days. Which module were they for?', 'payments'],
  [0.53, ['We have an accessibility audit next week.', 'The accessibility audit found missing labels on forms.', 'Screen readers skip our modal, says the accessibility report.', 'Fixed the contrast issues from the accessibility audit.', 'Accessibility: focus order on the settings page is wrong.', 'Most accessibility findings are closed.', 'The accessibility auditor re-tested the forms.', 'We passed the accessibility re-test.'], 'We went through an audit. What kind?', 'accessibility'],
  [0.64, ['We should hire a designer, the UI is drifting.', 'Posted the designer job ad.', 'Three designer candidates so far.', 'The second designer candidate has a great portfolio.', 'Designer interviews are on Wednesday.', 'Made an offer to the designer.', 'The designer accepted, starts next month.', 'Setting up accounts for the new designer.'], 'We hired for one role. Which role?', 'designer'],
  [0.75, ['The site is down, browsers say the certificate expired.', 'The certificate renewal job had been failing silently.', 'Renewed the certificate by hand, site is back.', 'Adding an alert for certificate expiry.', 'Postmortem: certificate renewal had no monitoring.', 'Moved certificate renewal to the new scheduler.', 'Certificate alert tested, it fires 14 days early.', 'Closing the certificate outage postmortem.'], 'What took the site down in the outage?', 'certificate'],
  [0.85, ['A distributor in Helsinki wants the app in Finnish.', 'Finnish strings are long, layouts will break.', 'Sent the Finnish strings to the translator.', 'Finnish translation is back, mostly done.', 'Fixed layouts that broke in Finnish.', 'Finnish dates format differently, fixed.', 'Finnish build shipped to the distributor.', 'The distributor likes the Finnish version.'], 'Which language did we translate the app into?', 'Finnish'],
  [0.93, ['Ledgerly launched the same feature we planned.', 'Ledgerly charges more than us, though.', 'A prospect chose Ledgerly over us.', 'Drafted a comparison page against Ledgerly.', 'Ledgerly has no export either.', 'We win on price against Ledgerly.', 'Ledgerly cut their prices this week.', 'Stop watching Ledgerly, back to our roadmap.'], 'Which competitor did we keep comparing ourselves with?', 'Ledgerly'],
];
const who = ['I', 'We', 'Jun', 'Mira', 'Oskar'];
const did = ['pushed a fix for', 'reviewed', 'started on', 'rewrote', 'tested', 'looked into', 'cleaned up', 'paired on', 'left comments on', 'timeboxed'];
const what = ['the sidebar spacing', 'the settings screen', 'the login form', 'the export dialog', 'the onboarding emails', 'the search page', 'the release notes', 'the empty states', 'the table headers', 'the error messages', 'the import job', 'the mobile layout', 'the changelog', 'the analytics events', 'the deploy docs', 'the dashboard graphs'];
const how = ['before lunch.', 'and it looks fine now.', 'but it needs another pass.', 'while waiting for CI.', 'and left notes in the ticket.', 'with mixed results.', 'and nothing surprising came up.', 'so the review can start tomorrow.'];
const asides = ['The standup ran long again.', 'Coffee machine is fixed, by the way.', 'Retro moves to the end of the week.', 'Reminder to log your hours before Friday.', 'Lunch order goes in at noon.', 'The support inbox was quiet today.', 'Can we squash commits before merging?', 'The calendar invite for planning went out.', 'I am out tomorrow afternoon.', 'Lint complained about unused imports again.'];

// The thread, the same every run: chatter by three authors, about 400 bytes a post, a tenth of them long enough to need
// the writer, and every planted sentence inside chatter.
function thread(N) {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chatter = (n) => Array.from({ length: n }, () => rand() < 0.2 ? pick(asides) : `${pick(who)} ${pick(did)} ${pick(what)} ${pick(how)}`).join(' ');
  const posts = Array.from({ length: N }, () => ({ author: pick(['oskar', 'mira', 'jun']), body: chatter(rand() < 0.1 ? 14 : 6 + Math.floor(rand() * 4)) }));
  const taken = new Set();
  const plant = (share, sentence) => {
    let k = Math.min(N - 1, Math.round(share * N));
    while (taken.has(k)) k = (k + 1) % N;
    taken.add(k);
    posts[k].body = `${chatter(2)} ${sentence} ${chatter(2)}`;
    return k;
  };
  const questions = [
    ...details.map(([at, said, q, a]) => ({ q, a, kind: 'detail', at: plant(at, said) })),
    ...changes.map(([at, then, said, now, q, a]) => (plant(at, said), { q, a, kind: 'superseded', at: plant(then, now) })),
    ...gists.map(([at, said, q, a]) => ({ q, a, kind: 'gist', at: said.map((s, j) => plant(at + 2 * j / N, s)).at(-1) })),
  ];
  return { posts, questions };
}

const { posts, questions } = thread(Number(opts.posts));
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
    await api('POST', `/api/threads/${id}/entries`, { body, to: null }, author);
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
writeFileSync(opts.out, JSON.stringify({ model, writer, window: WINDOW, every: EVERY, posts: N, lines: lines.length, written, rows }, null, 2));
console.log(`\nevery answer in ${opts.out}`);

const share = (name, f = () => true) => { const l = by[name].filter(f); return l.filter((r) => r.ok).length / (l.length || 1); };
check(share('tree') > share('pi'), 'memory recalls more than Pi\'s own compaction', `${recall(by.tree)} vs ${recall(by.pi)}`);
check(share('search', (r) => r.kind === 'detail') >= share('tree', (r) => r.kind === 'detail'), 'searching recalls at least the details the tree does', `${recall(by.search.filter((r) => r.kind === 'detail'))} vs ${recall(by.tree.filter((r) => r.kind === 'detail'))}`);
check(share('search') >= share('full') - 0.1, 'memory with search comes within 10 points of everything in context', `${recall(by.search)} vs ${recall(by.full)}`);
done();
