// The runner reports status only to a terminal that answers the OSC 7501 query before device attributes (DA),
// which every terminal answers. We play the terminal in a pty (Bun 1.3.5+): once answering both, once only DA.
import { base, check, dir, done, repo, server } from './lib.js';

async function terminal(answers7501, ms = 4000) {
  let out = '';
  let answered = false;
  const env = { ...process.env };
  delete env.STATUS;
  const p = Bun.spawn(['bun', 'runner.js', '--server', base, '--name', 'pty', '--dir', dir], {
    cwd: repo,
    env,
    terminal: {
      data(t, bytes) {
        out += new TextDecoder().decode(bytes);
        if (!answered && out.includes('\x1b[c')) {
          answered = true;
          t.write((answers7501 ? '\x1b]7501;?\x1b\\' : '') + '\x1b[?62;22c');
        }
      },
    },
  });
  await Bun.sleep(ms);
  p.kill('SIGKILL');
  await p.exited;
  return out;
}

await server();
const yes = await terminal(true);
const no = await terminal(false);
check(yes.includes('state=idle'), 'a terminal that answers the query gets reports', JSON.stringify(yes.slice(-200)));
check(no.includes('\x1b[c') && !no.includes(']7501;state'), 'a terminal that only answers DA gets none', JSON.stringify(no.slice(-200)));

done();
