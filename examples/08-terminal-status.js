// The runner tells its terminal over OSC 7501 how its threads stand: a root record and one per thread, with no
// prompt or answer text. Its stdout is a pipe here, so STATUS=1 forces reports on; 09 shows a real terminal.
import { api, check, done, runner, server, sleep, until, view } from './lib.js';

const reports = [];
const records = new Map();
const record = (id) => records.get(String(id));
const decode = (b64) => b64 && Buffer.from(b64, 'base64').toString();
function watch(p) {
  let out = '';
  p.stdout.on('data', (d) => {
    out += d;
    for (const match of out.matchAll(/\x1b\]7501;([^\x1b\x07]*)\x1b\\/g)) {
      const pairs = Object.fromEntries(match[1].split(':').map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
      const report = { ...pairs, title: decode(pairs.title), msg: decode(pairs.msg) };
      reports.push(report);
      const id = pairs.id ?? '';
      if (pairs.state !== 'clear') records.set(id, report);
      else if (id) records.delete(id);
      else records.clear();
    }
    out = out.slice(out.lastIndexOf('\x1b') === -1 ? out.length : out.lastIndexOf('\x1b'));
    if (!out.startsWith('\x1b]7501;')) out = '';
  });
}

const srv = await server();

// Off by default when stdout isn't a terminal: no reports at all.
const quiet = await runner('quiet', { wait: false });
let quietOut = '';
quiet.stdout.on('data', (d) => { quietOut += d; });

watch(await runner('laptop', { args: ['--owner', 'oskar'], env: { STATUS: '1' }, wait: false }));
check(Boolean(await until(async () => record('')?.state === 'idle', 8000, 50)), 'root record idle once online', JSON.stringify(reports));
check(record('')?.app === 'agent-ide' && record('')?.msg.includes('laptop'), 'root record names the app and the runner', JSON.stringify(record('')));

const { json: { id } } = await api('POST', '/api/threads', { title: 'Status test' });
await api('POST', `/api/threads/${id}/entries`, { body: 'a secret prompt', to: { runner: 'laptop', model: 'echo/echo' } });
check(Boolean(await until(async () => record(id)?.state === 'done', 8000, 50)), 'thread record done after the answer', JSON.stringify(reports));
check(record(id)?.title === `#${id} Status test` && record(id)?.msg === 'echo@laptop', 'title is the thread, msg its agents on this runner', JSON.stringify(record(id)));
check(!reports.some((r) => `${r.title}${r.msg}`.includes('secret') || `${r.title}${r.msg}`.includes('heard')), 'no prompt or answer text in any report');
check(!reports.some((r) => r.app && r.id), 'only the root names the app; threads inherit it');

// A command in the runner's folder: working, root too, then done.
await api('POST', `/api/threads/${id}/entries`, { body: '$ sleep 1.5' });
check(Boolean(await until(async () => record(id)?.state === 'working' && record('')?.state === 'working', 8000, 50)), 'thread and root working during a command', JSON.stringify([...records]));
check(Boolean(await until(async () => record(id)?.state === 'done' && record('')?.state === 'idle', 8000, 50)), 'done again after it, root idle');

// Another reader reading it changes nothing; the owner reading it clears the record.
await api('POST', `/api/threads/${id}/read`, {}, 'ana');
await sleep(500);
check(record(id)?.state === 'done', 'someone else reading leaves it done for the owner');
await api('POST', `/api/threads/${id}/read`, {}, 'oskar');
check(Boolean(await until(async () => !records.has(String(id)), 8000, 50)), 'the owner reading it clears the record', JSON.stringify(reports.at(-1)));

// A thread whose agents are on another runner never shows here.
const { json: { id: other } } = await api('POST', '/api/threads', { title: 'Elsewhere' });
await api('POST', `/api/threads/${other}/entries`, { body: 'hi', to: { runner: 'quiet', model: 'echo/echo' } });
await until(async () => (await view(other)).status === 'done', 8000, 50);
await sleep(500);
check(!reports.some((r) => r.id === String(other)), 'a thread answered on another runner is not reported');

const before = reports.length;
await api('POST', `/api/threads/${other}/read`, {}, 'oskar');
await sleep(500);
check(reports.length === before, 'nothing is re-sent when this runner\'s records did not change', JSON.stringify(reports.slice(before)));

// A failure: the reader sees error until they read it.
const { json: { id: broken } } = await api('POST', '/api/threads', { title: 'Broken' });
const bad = await api('POST', `/api/threads/${broken}/entries`, { body: 'hi', to: { runner: 'laptop', model: 'nope/nope' } });
check(Boolean(await until(async () => record(broken)?.state === 'error', 15000, 50)), 'a thread whose agent gave no answer reports error', `${JSON.stringify(bad)} ${JSON.stringify((await view(broken)).status)}`);
check((await api('GET', '/api/threads')).json.find((t) => t.id === broken)?.status === 'error', 'the API says error too');

// The server goes away: thread records are cleared, the root says it's offline.
srv.kill();
check(Boolean(await until(async () => records.size === 1 && record('')?.state === 'idle' && record('')?.msg.includes('offline'), 8000, 50)), 'server gone: only the root is left, offline', JSON.stringify([...records]));

check(!quietOut.includes('\x1b]7501'), 'a runner whose stdout is not a terminal reports nothing');

done();
