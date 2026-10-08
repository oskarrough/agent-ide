// Modules turn off whole: TALK=0 and STATUS=0 remove talk and status. Each check runs with the module on first,
// so the off case proves something.
import { rmSync } from 'node:fs';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { api, call, check, conversationOf, db, done, runner, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

// Pi carries the tools and the system prompt in system messages.
let offered = [];
let prompt = '';
const route = (request) => {
  offered = getCurrentTools(request.messages).map((t) => t.name);
  prompt = JSON.stringify(request.messages.filter((m) => m.role === 'system'));
  const last = request.messages.findLast((m) => m.role !== 'system');
  if (last.role === 'toolResult') return say(`tool said: ${text(last)}`);
  if (text(last).includes('delegate')) return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo@bot' });
  return say(`heard: ${text(last)}`);
};

const fresh = () => { for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true }); };

async function round(env) {
  fresh();
  const srv = await server(env);
  const told = [];
  const bot = await scriptedRunner('bot', route, { onTell: (message) => told.push(message) });
  const { modules } = (await api('GET', '/api/server')).json;
  const { json: { id } } = await api('POST', '/api/threads', { title: 'parent' });
  await api('POST', `/api/threads/${id}/entries`, { body: 'please delegate this', to: { runner: 'bot', model: 'echo/echo' } });
  const result = await until(async () => (await conversationOf(await view(id), 'echo@bot')).entries.find((e) => e.kind === 'pi.tool-result'));
  await until(async () => (await view(id)).status !== 'working');
  await sleep(1000);
  const children = (await api('GET', '/api/threads')).json.filter((t) => t.parent === id);
  const parent = await view(id);
  bot.close();
  srv.kill();
  await sleep(300);
  return { modules, told, offered, prompt, result: result && text(result.model[0]), children, parent };
}

const on = await round({});
check(on.modules.join() === 'talk,status', 'by default talk and status are on, the director off', JSON.stringify(on.modules));
check(on.offered.includes('post') && on.offered.includes('threads') && on.offered.includes('read'), 'talk on: the model has post and threads, beside Pi\'s own read', JSON.stringify(on.offered));
check(on.prompt.includes('end your turn'), 'talk on: its instructions are in the prompt');
check(on.children.length === 1, 'talk on: the post starts a child');
check(on.parent.entries.some((e) => e.data.from && e.data.re), 'talk on: the answer comes back');
check(on.told.some((m) => m.op === 'status'), 'status on: the runner is told how its threads stand');

const off = await round({ TALK: '0', STATUS: '0' });
check(off.modules.length === 0, 'TALK=0 STATUS=0: no modules', JSON.stringify(off.modules));
check(!off.offered.includes('post') && !off.offered.includes('threads') && off.offered.includes('bash'), 'talk off: no post or threads, still the coding tools', JSON.stringify(off.offered));
check(!off.prompt.includes('end your turn'), 'talk off: nothing about other threads in the prompt');
check(Boolean(off.result) && !/Posted to thread/.test(off.result), 'talk off: a post call fails', off.result);
check(off.children.length === 0, 'talk off: no child thread');
check(off.told.length === 0, 'status off: no status pushes', JSON.stringify(off.told));

// The runner end: STATUS=1 reports even to a pipe; STATUS=0 drops the module.
fresh();
const srv = await server();
for (const status of ['1', '0']) {
  let out = '';
  const r = await runner(`laptop${status}`, { env: { STATUS: status }, wait: false });
  r.stdout.on('data', (d) => { out += d; });
  await until(() => api('GET', '/api/runners').then((x) => x.json.some((y) => y.name === `laptop${status}` && y.online)));
  await sleep(1000);
  r.kill();
  check(out.includes('\x1b]7501;') === (status === '1'), `runner STATUS=${status}: ${status === '1' ? 'reports' : 'no'} OSC 7501`, JSON.stringify(out.slice(-200)));
}
srv.kill();
done();
