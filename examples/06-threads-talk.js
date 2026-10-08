// Threads talking: an agent's `post` and `threads` tools. The answer to a post comes back with `from` and `re`
// and wakes the agent who posted, asking nothing back. The server is killed mid-call; the rerun finds the child it started.
// Killed again later, it replays nothing: no old reply asks anyone again.
import { answers, api, brief, call, check, conversationOf, done, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

let srv = await server();

const bot = await scriptedRunner('bot', (request) => {
  const last = request.messages.findLast((m) => m.role !== 'system');
  const t = text(last);
  if (last.role === 'toolResult') return say(`tool said: ${t}`);
  if (t.includes('answering from thread')) return say(`Got it: ${t.split('\n')[0]}`);
  if (t.includes('delegate')) return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo/echo@bot' });
  if (t.includes('compute 2+2')) return say('4, after some thought '.repeat(20));
  if (t.includes('list threads')) return call('threads', {});
  if (t.includes('read child')) return call('threads', { thread: Number(t.match(/child (\d+)/)[1]) });
  if (t.includes('own thread')) return call('post', { thread: Number(t.match(/thread (\d+)/)[1]), body: 'hi me' });
  return say(`heard: ${t}`);
});
const to = { runner: 'bot', model: 'echo/echo' };

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'parent' });
await api('POST', `/api/threads/${parent}/entries`, { body: 'please delegate this', to });

// Kill the server the moment the child appears, so the tool call or the child's answer replays.
const child = await until(async () => (await api('GET', '/api/threads')).json.find((t) => t.parent === parent), 10000, 5);
check(Boolean(child), 'the agent started a child thread');
srv.kill('SIGKILL');
await sleep(300);
srv = await server();

const woke = await until(async () => {
  const v = await view(parent);
  return answers(v).some((e) => e.data.body.startsWith('Got it')) && v.status !== 'working' ? v : null;
}, 20000);
check(Boolean(woke), 'the child\'s answer woke the parent agent', woke ? '' : brief(await view(parent)));

const threads = (await api('GET', '/api/threads')).json;
check(threads.filter((t) => t.parent === parent).length === 1, 'exactly one child after the restart', JSON.stringify(threads));
const kid = await view(child.id);
const asks = kid.entries.filter((e) => e.data.from === parent);
check(asks.length === 1 && asks[0].data.author === 'echo/echo@bot' && asks[0].data.to?.[0].model === 'echo/echo', 'one post in the child, by the parent agent', brief(kid));
check(answers(kid).length === 1, 'the child answered once', brief(kid));
const p = await view(parent);
const replies = p.entries.filter((e) => e.data.from === child.id && e.data.re);
check(replies.length === 1 && replies[0].data.to?.[0].runner === 'bot', 'one reply in the parent, from the child\'s agent, asking the parent\'s', brief(p));
check(!asks[0]?.data.re && asks[0]?.data.body === 'compute 2+2', 'the post says it came from the parent', JSON.stringify(asks[0]));
check(replies[0]?.data.re?.[0] === asks[0]?.id && replies[0]?.data.body.startsWith('4, after'), 'the reply says where it came from and which post it answers', JSON.stringify(replies[0]?.data).slice(0, 300));
await sleep(1500);
check((await view(child.id)).entries.filter((e) => e.data.from === parent).length === 1, 'the parent\'s answer to the reply stays in the parent: no ping-pong');
check(!p.entries.some((e) => e.data.from === child.id && !e.data.re), 'no report on top of the reply');
check(p.entries.some((e) => e.data.body.includes('handed off')), 'hand-off message in the parent');

// The tools run in the parent agent's own conversation, so their results are there.
const results = async () => (await conversationOf(await view(parent), 'echo/echo@bot')).entries.filter((e) => e.kind === 'pi.tool-result').map((e) => text(e.model[0]));
const idle = () => until(async () => (await view(parent)).status !== 'working');
await api('POST', `/api/threads/${parent}/entries`, { body: 'list threads' });
const listed = await until(async () => (await results()).find((t) => t.includes('(yours)')));
check(Boolean(listed) && listed.includes(`#${child.id} sum, child of #${parent}`), 'threads lists threads', listed);
await idle();
await api('POST', `/api/threads/${parent}/entries`, { body: `read child ${child.id}` });
const read = await until(async () => (await results()).find((t) => t.includes('compute 2+2')));
check(Boolean(read) && /echo\/echo@bot from thread \d+ to echo\/echo@bot: compute 2\+2/.test(read) && read.includes('4, after'), 'threads shows a thread\'s messages', read);
await idle();

// Posting to its own thread is refused, as a tool error the model sees.
await api('POST', `/api/threads/${parent}/entries`, { body: `post to own thread ${parent}` });
check(Boolean(await until(async () => (await results()).find((t) => t.includes('your own thread')))), 'posting to its own thread is refused');
await idle();

// The human hand-off still works: a human posts in a child, and the answer is reported in the parent.
const { json: { id: human } } = await api('POST', '/api/threads', { title: 'by hand', parent });
await api('POST', `/api/threads/${human}/entries`, { body: 'hello there', to });
const report = await until(async () => (await view(parent)).entries.find((e) => e.data.from === human && e.data.body === 'heard: oskar: hello there'));
check(Boolean(report), 'a human\'s hand-off still reports to the parent');

// A note that asks nobody, then a restart. Nothing asks the agent again, so nobody answers the note.
const settledParent = await view(parent);
await api('POST', `/api/threads/${parent}/entries`, { body: 'just a note', to: null });
srv.kill('SIGKILL');
await sleep(300);
srv = await server();
await sleep(2000);
const quiet = await view(parent);
check(answers(quiet).length === answers(settledParent).length && quiet.status !== 'working', 'after a restart no old reply asks again: the note stays unanswered', brief(quiet));

bot.close();
done();
