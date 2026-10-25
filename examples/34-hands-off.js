// A thread's tools, as `pi --tools` takes them. `-write,-edit,-bash` makes a thread hands off: its agents read and
// ask, and the work happens in the child threads they start, which have every tool. A fork keeps the thread's tools,
// and a thread's tools can change at any time.
import { answered, api, call, check, done, say, scriptedRunner, server, until, view } from './lib.js';

await server();
const offered = [];
await scriptedRunner('bot', (request) => {
  // Pi Durable sends tools as positional system messages: the ones added, and later any removed.
  const tools = new Set();
  for (const m of request.messages.filter((m) => m.role === 'system')) {
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name ?? t);
  }
  const names = [...tools].sort().join(',');
  offered.push(names);
  const t = JSON.stringify(request.messages.at(-1)?.content ?? '');
  if (t.includes('delegate') && !t.includes('Posted')) return call('post', { title: 'work', body: 'run it', to: 'echo/echo@bot' });
  return say(`tools: ${names}`);
});
const to = { runner: 'bot', model: 'echo/echo' };

const bad = await api('POST', '/api/threads', { title: 'x', tools: ['-bash', 'read'] });
check(bad.status === 400 && bad.json.error.includes('mixed'), 'names and -name entries don\'t mix, as in pi', JSON.stringify(bad.json));
const unknown = await api('POST', '/api/threads', { title: 'x', tools: ['-sudo'] });
check(unknown.status === 400 && unknown.json.error.includes('No tool sudo'), 'an unknown tool is refused, naming the ones there are', JSON.stringify(unknown.json));

const { json: { id } } = await api('POST', '/api/threads', { title: 'lead', tools: ['-write', '-edit', '-bash'] });
check(JSON.stringify((await view(id)).tools) === '["-write","-edit","-bash"]', 'the thread keeps its tools');
await api('POST', `/api/threads/${id}/entries`, { body: 'which tools?', to });
const first = await answered(id, 1);
const said = first.entries.find((e) => e.data.answer)?.data.body ?? '';
check(said.includes('read') && !/\b(write|edit|bash)\b/.test(said), 'an agent in it is offered no write, edit or bash', said);

// It delegates: the child it starts has every tool.
await api('POST', `/api/threads/${id}/entries`, { body: 'delegate this', to });
const child = await until(async () => (await api('GET', '/api/threads')).json.find((t) => t.parent === id), 10000);
const work = await answered(child.id, 1, 10000);
const there = work.entries.find((e) => e.data.answer)?.data.body ?? '';
check(child.tools === null && /\bbash\b/.test(there) && /\bwrite\b/.test(there), 'the child it starts has every tool', there);

// A fork keeps them.
const { json: fork } = await api('POST', `/api/threads/${id}/fork`, { at: first.entries.find((e) => e.data.answer).id });
check(JSON.stringify((await view(fork.id)).tools) === '["-write","-edit","-bash"]', 'a fork keeps the thread\'s tools');

// Exactly these: a list of names.
const { json: { id: only } } = await api('POST', '/api/threads', { title: 'only read', tools: ['read'] });
await api('POST', `/api/threads/${only}/entries`, { body: 'which tools?', to });
const just = (await answered(only, 1)).entries.find((e) => e.data.answer)?.data.body ?? '';
check(just === 'tools: read', 'a list of names enables exactly those', just);

// Turned off and on again later, for its agents too.
await api('POST', `/api/threads/${id}/tools`, { tools: null });
await api('POST', `/api/threads/${id}/entries`, { body: 'which tools now?', to });
const now = (await answered(id, 3, 10000)).entries.filter((e) => e.data.answer).at(-1)?.data.body ?? '';
check(/\bbash\b/.test(now) && (await view(id)).tools === null, 'tools: null gives a thread every tool again', now);

done();
