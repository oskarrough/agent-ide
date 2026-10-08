// Threads talking. An agent has two tools of its own: `post` to another thread or a new child, and `read` one.
// Its post says which thread it came from; the answer comes back as an input that says who answered (`from`)
// and which post it answers (`re`), and wakes the asker. An answer asks for nothing back, so no ping-pong.
// The model is a script, and the server is killed mid-call: the rerun finds the child it already started.
// bun examples/06-threads-talk.js
import { api, call, check, done, kinds, messageText, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

let srv = await server();

// What the model says, by the last thing it was told.
const bot = await scriptedRunner('bot', (request) => {
  const last = request.messages.findLast((m) => m.role !== 'system');
  const t = text(last);
  if (last.role === 'toolResult') return say(`tool said: ${t}`);
  if (t.includes('answering from thread')) return say(`Got it: ${t.split('\n')[0]}`);
  if (t.includes('delegate')) return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo@bot' });
  if (t.includes('compute 2+2')) return say('4, after some thought '.repeat(20));
  if (t.includes('list threads')) return call('read', {});
  if (t.includes('read child')) return call('read', { thread: Number(t.match(/child (\d+)/)[1]) });
  if (t.includes('own thread')) return call('post', { thread: Number(t.match(/thread (\d+)/)[1]), body: 'hi me' });
  return say(`heard: ${t}`);
});
const to = { runner: 'bot', model: 'echo/echo' };

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'parent' });
await api('POST', `/api/threads/${parent}/entries`, { body: 'please delegate this', to });

// The parent agent starts a child. Kill the server the moment the child appears, so the tool call
// or the child's answer may replay after the restart.
const child = await until(async () => (await api('GET', '/api/threads')).json.find((t) => t.parent === parent), 10000, 5);
check(Boolean(child), 'the agent started a child thread');
srv.kill('SIGKILL');
await sleep(300);
srv = await server();

const woke = await until(async () => {
  const v = await view(parent);
  return v.entries.some((e) => e.entry.kind === 'pi.assistant' && messageText(e).startsWith('Got it')) && v.status !== 'working' ? v : null;
}, 20000);
check(Boolean(woke), 'the child\'s answer woke the parent agent', woke ? '' : kinds(await view(parent)));

const threads = (await api('GET', '/api/threads')).json;
check(threads.filter((t) => t.parent === parent).length === 1, 'exactly one child after the restart', JSON.stringify(threads));
const kid = await view(child.id);
const asks = kid.entries.filter((e) => e.entry.kind === 'pi.user');
check(asks.length === 1 && asks[0].author === 'echo@bot' && asks[0].to?.model === 'echo/echo', 'one input in the child, by the parent agent', kinds(kid));
check(kid.entries.filter((e) => e.entry.kind === 'pi.assistant').length === 1, 'the child answered once', kinds(kid));
const p = await view(parent);
const replies = p.entries.filter((e) => e.entry.kind === 'pi.user' && e.author === 'echo@bot');
check(replies.length === 1 && replies[0].to?.runner === 'bot', 'one reply input in the parent, from the child\'s agent', kinds(p));
check(asks[0]?.from === parent && !asks[0]?.re && asks[0]?.body === 'compute 2+2', 'the post says it came from the parent', JSON.stringify(asks[0] && { from: asks[0].from, re: asks[0].re, body: asks[0].body }));
check(replies[0]?.from === child.id && replies[0]?.re?.[0] === asks[0]?.entry.id && replies[0]?.body.startsWith('4, after'), 'the reply says where it came from and which post it answers', JSON.stringify(replies[0] && { from: replies[0].from, re: replies[0].re, body: replies[0].body.slice(0, 20) }));
await sleep(1500);
check((await view(child.id)).entries.filter((e) => e.entry.kind === 'pi.user').length === 1, 'the parent\'s answer to the reply stays in the parent: no ping-pong');
check(!p.entries.some((e) => e.entry.kind === 'agent-ide.note' && e.entry.data.text.startsWith('echo@bot:')), 'no passive note on top of the reply');
check(p.entries.some((e) => e.entry.kind === 'agent-ide.note' && e.entry.data.text.includes('handed off')), 'hand-off note in the parent');

// read: list threads, then a thread's entries.
await api('POST', `/api/threads/${parent}/entries`, { body: 'list threads' });
const listed = await until(async () => (await view(parent)).entries.findLast((e) => e.entry.kind === 'pi.tool-result' && messageText(e).includes('#')));
check(Boolean(listed) && messageText(listed).includes(`#${child.id} sum, child of #${parent}`) && messageText(listed).includes('(yours)'), 'read lists threads', listed && messageText(listed));
await until(async () => (await view(parent)).status !== 'working');
await api('POST', `/api/threads/${parent}/entries`, { body: `read child ${child.id}` });
const read = await until(async () => (await view(parent)).entries.findLast((e) => e.entry.kind === 'pi.tool-result' && messageText(e).includes('compute 2+2')));
check(Boolean(read) && /echo@bot from thread \d+ to echo@bot: compute 2\+2/.test(messageText(read)) && messageText(read).includes('4, after'), 'read shows a thread\'s entries', read && messageText(read));
await until(async () => (await view(parent)).status !== 'working');

// Posting to its own thread is refused, as a tool error the model sees.
await api('POST', `/api/threads/${parent}/entries`, { body: `post to own thread ${parent}` });
const refused = await until(async () => (await view(parent)).entries.findLast((e) => e.entry.kind === 'pi.tool-result' && messageText(e).includes('your own thread')));
check(Boolean(refused), 'posting to its own thread is refused');
await until(async () => (await view(parent)).status !== 'working');

// The human hand-off still works: a human posts in a child, and the answer is a note in the parent.
const { json: { id: human } } = await api('POST', '/api/threads', { title: 'by hand', parent });
await api('POST', `/api/threads/${human}/entries`, { body: 'hello there', to });
const note = await until(async () => (await view(parent)).entries.find((e) => e.entry.kind === 'agent-ide.note' && e.entry.data.text.startsWith('echo@bot: heard')));
check(Boolean(note), 'a human\'s hand-off still reports as a note');

bot.close();
done();
