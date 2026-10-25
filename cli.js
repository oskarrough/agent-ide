// The API from a terminal: send to any agents in any thread, and print what comes back.
import { parseArgs } from 'node:util';

const usage = `bun cli.js [--server url] [--as name] <command>

  send <message>   post to a new thread, or --thread N, and print the answers as they land
                   --to agent    model@runner, a runner for its default model, or nobody; repeat for more
                                 (left out: whom the thread last asked)
                   --effort e    how hard they think: off, minimal, low, medium, high, xhigh, max
                   --dir d       a folder inside the runner's
                   --title t     the new thread's title (the message's start by default)
                   --steer       join the answer being written
                   --no-wait     post and return
                   A message starting with "$ " runs a command on the runner.
  threads          every thread, with its status and agents
  read <thread>    a thread's messages, or its --last N
  runners          every runner, online or not, and its models
  stop <thread>    stop its agents and commands`;

const parse = (options) => {
  try { return parseArgs({ allowPositionals: true, options }); } catch (error) { console.error(`${error.message}\n\n${usage}`); process.exit(1); }
};
const { values: o, positionals: [command, ...rest] } = parse({
  server: { type: 'string', default: process.env.AGENT_IDE_SERVER || 'http://127.0.0.1:3000' },
  as: { type: 'string', default: process.env.USER || 'anon' },
  thread: { type: 'string' }, to: { type: 'string', multiple: true }, effort: { type: 'string' }, dir: { type: 'string' },
  title: { type: 'string' }, steer: { type: 'boolean' }, 'no-wait': { type: 'boolean' }, last: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

async function api(method, route, body) {
  const res = await fetch(o.server + route, { method, headers: { 'content-type': 'application/json', 'x-user': o.as }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

// As the agents' own `post` tool names them: the last @ splits the model from the runner.
function agent(name) {
  if (name === 'nobody') return null;
  const at = name.lastIndexOf('@');
  return { runner: name.slice(at + 1), model: at < 0 ? '' : name.slice(0, at), ...(o.effort ? { effort: o.effort } : {}), ...(o.dir ? { dir: o.dir } : {}) };
}

function show({ id, data: m }) {
  const shell = m.shell && [m.shell.stdout, m.shell.stderr, m.shell.error, m.shell.code ? `exit ${m.shell.code}` : ''].filter(Boolean).join('\n');
  console.log(`#${id} ${m.author}${m.to ? ` → ${m.to.map((t) => `${t.model}@${t.runner}`).join(', ')}` : ''}${m.from ? ` (from thread ${m.from})` : ''}\n${m.body}${shell ? `\n${shell}` : ''}\n`);
}

async function send() {
  const body = rest.join(' ');
  if (!body) throw new Error('send what?');
  const id = o.thread ? Number(o.thread) : (await api('POST', '/api/threads', { title: o.title ?? body.slice(0, 60) })).id;
  if (!o.thread) console.error(`thread ${id}`);
  const seen = (await api('GET', `/api/threads/${id}`)).entries.at(-1)?.id ?? 0;
  const to = o.to && (o.to.includes('nobody') ? null : o.to.map(agent));
  const posted = await api('POST', `/api/threads/${id}/entries`, { body, ...(o.to ? { to } : {}), ...(o.steer ? { steer: true } : {}), requestId: crypto.randomUUID() });
  if (o['no-wait'] || !(posted.command || posted.to?.length)) return;
  // Poll until something new from someone else has landed and nobody is still working on it.
  let last = posted.entry ?? seen;
  let heard = false;
  let waiting = '';
  for (;;) {
    const view = await api('GET', `/api/threads/${id}`);
    for (const e of view.entries.filter((e) => e.id > last)) {
      if (e.id !== posted.entry) show(e);
      heard ||= e.id !== posted.entry;
      last = e.id;
    }
    const blocked = view.agents.filter((a) => a.status === 'blocked').map((a) => a.to?.runner);
    if (blocked.join() !== waiting && (waiting = blocked.join())) console.error(`waiting for ${waiting}, offline…`);
    if (heard && !['working', 'blocked'].includes(view.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const commands = {
  send,
  async threads() {
    for (const t of await api('GET', '/api/threads')) console.log(`#${t.id} ${t.title}  ${t.status}${t.agents.length ? `  ${t.agents.map((a) => a.name).join(', ')}` : ''}${t.parent ? `  child of #${t.parent}` : ''}`);
  },
  async read() {
    const { entries } = await api('GET', `/api/threads/${Number(rest[0])}`);
    for (const e of entries.slice(-(Number(o.last) || entries.length))) show(e);
  },
  async runners() {
    for (const r of await api('GET', '/api/runners')) {
      console.log(`${r.name} ${r.online ? 'online' : 'offline'}  ${r.dir}${r.readOnly ? ' (read-only)' : ''}  default ${r.model || `none${r.modelError ? `: ${r.modelError}` : ''}`}`);
      for (const m of r.offers) console.log(`  ${m}@${r.name}`);
    }
  },
  stop: () => api('POST', `/api/threads/${Number(rest[0])}/stop`),
};

if (o.help || !commands[command]) {
  console.log(usage);
  process.exit(o.help ? 0 : 1);
}
await commands[command]().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
