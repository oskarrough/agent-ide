// Terminal status, both ends. On by default; STATUS=0 turns it off, on the server or a runner. On a runner, STATUS=1
// also skips asking the terminal, for when stdout isn't one.
// The server tells each runner how the threads its agents answer stand; the runner tells its terminal with the
// Program Status Protocol (OSC 7501): one record per thread, by id, and its own root record.

// ── Server end ──

// Each runner hears how the threads its agents answer stand for its owner, or for anyone if it has none.
// Idle threads are left out. One telling at a time, so an older one never lands after a newer one.
export function server({ runners, known, threadList, agentName }) {
  let telling;
  let again = false;
  function changed() {
    if (telling) return void (again = true);
    telling = (async () => {
      const all = await known();
      for (const name of Object.keys(all).filter(runners.isOnline)) {
        const threads = (await threadList(all[name].owner))
          .filter((t) => t.agent?.runner === name && t.status !== 'idle')
          .map(({ id, title, agent, status }) => ({ id, title, agent: agentName(agent), status }));
        runners.tell(name, { op: 'status', threads });
      }
    })().catch((error) => console.error(error)).finally(() => {
      telling = undefined;
      if (again) { again = false; changed(); }
    });
  }
  return { changed };
}

// ── Runner end ──

// Messages are the agent's name, never what was asked or answered. Like pi: only when the terminal answers the
// query, or with STATUS=1.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
// Cut by characters so the limits hold in UTF-8: title 192 bytes, msg 2048.
const base64 = (text, max) => Buffer.from([...text.replace(CONTROL_CHARACTERS, ' ').trim()].slice(0, max).join('')).toString('base64');
function programStatus({ state, id, app, title, msg }) {
  const pairs = [`state=${state}`, id && `id=${id}`, app && `app=${app}`, title && `title=${base64(title, 48)}`, msg && `msg=${base64(msg, 500)}`];
  return `\x1b]7501;${pairs.filter(Boolean).join(':')}\x1b\\`;
}

// A terminal that speaks OSC 7501 answers its query before the device attributes every terminal answers.
function detect() {
  if (process.env.STATUS === '1') return Promise.resolve(true);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    let reply = '';
    const done = (supported) => {
      clearTimeout(timer);
      process.stdin.off('data', read).setRawMode(false).pause();
      resolve(supported);
    };
    const read = (chunk) => {
      reply += chunk;
      if (reply.includes('\x1b]7501;?')) done(true);
      else if (/\x1b\[\?[\d;]*c/.test(reply)) done(false);
    };
    const timer = setTimeout(() => done(false), 1000);
    process.stdin.setRawMode(true).setEncoding('utf8').on('data', read);
    process.stdout.write('\x1b]7501;?\x1b\\\x1b[c');
  });
}

export async function runner({ name, server }) {
  if (!await detect()) return {};
  // Each report replaces its record whole, so a record is sent again only when it changed. Records not in `next` are cleared.
  let reported = new Map();
  function report(root, threads = []) {
    const next = new Map([['', programStatus({ state: root.state, app: 'agent-ide', msg: root.msg })]]);
    for (const t of threads) next.set(String(t.id), programStatus({ state: t.status, id: t.id, title: `#${t.id} ${t.title}`, msg: t.agent }));
    for (const id of reported.keys()) if (!next.has(id)) process.stdout.write(programStatus({ state: 'clear', id }));
    for (const [id, sequence] of next) if (reported.get(id) !== sequence) process.stdout.write(sequence);
    reported = next;
  }
  return {
    // A blocked thread waits for an offline runner, so this one, online, never hears of one.
    told({ op, threads }) {
      if (op !== 'status') return;
      const working = threads.filter((t) => t.status === 'working').length;
      report({ state: working ? 'working' : 'idle', msg: working ? `${name}: ${working} working` : `${name}: online at ${server}` }, threads);
    },
    // Its threads go on without this runner; it hears again how they stand when it reconnects.
    disconnected: () => report({ state: 'idle', msg: `${name}: offline, retrying ${server}` }),
  };
}
