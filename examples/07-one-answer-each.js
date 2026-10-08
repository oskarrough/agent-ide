// One answer each. An agent posts three times to a child thread that's still busy with the first.
// Every answer the child gives comes back to the parent exactly once, saying all the posts it answers.
// bun examples/07-one-answer-each.js
import { api, call, check, done, kinds, say, scriptedRunner, server, sleep, text, until, view } from './lib.js';

await server();

// What the model says, by the last thing it was told: ask once, then twice more while the child is still thinking.
const bot = await scriptedRunner('bot', (request) => {
  const last = request.messages.findLast((m) => m.role !== 'system');
  const t = text(last);
  const results = request.messages.filter((m) => m.role === 'toolResult');
  if (last.role === 'toolResult') {
    const child = Number(text(results[0]).match(/thread (\d+)/)?.[1]);
    if (results.length === 1) return call('post', { thread: child, body: 'and another thing' });
    if (results.length === 2) return call('post', { thread: child, body: 'and a third' });
    return say('waiting');
  }
  if (t.includes('answering from thread')) return say(`Got it: ${t.split('\n')[0]}`);
  if (t.includes('ask twice')) return call('post', { title: 'pair', body: 'slow question' });
  if (t.includes('slow question')) return say('thinking slowly '.repeat(80));
  if (t.includes('and another thing') || t.includes('and a third')) return say('one answer for the rest');
  return say(`heard: ${t}`);
});

const { json: { id: parent } } = await api('POST', '/api/threads', { title: 'dup' });
await api('POST', `/api/threads/${parent}/entries`, { body: 'ask twice', to: { runner: 'bot', model: 'echo/echo' } });
const settled = await until(async () => {
  const v = await view(parent);
  return v.entries.some((e) => e.entry.kind === 'pi.assistant' && JSON.stringify(e.entry.model).includes('Got it')) && v.status !== 'working' ? v : null;
}, 30000);
await sleep(4000);

const p = await view(parent);
const child = (await api('GET', '/api/threads')).json.find((t) => t.parent === parent);
const kid = child && await view(child.id);
const posts = kid?.entries.filter((e) => e.entry.kind === 'pi.user') ?? [];
const answers = kid?.entries.filter((e) => e.entry.kind === 'pi.assistant') ?? [];
const replies = p.entries.filter((e) => e.entry.kind === 'pi.user' && e.re);
console.log('answers in the child reply to:', JSON.stringify(answers.map((a) => a.replyTo)));
console.log('replies in the parent:', JSON.stringify(replies.map((r) => ({ re: r.re, body: r.body.slice(0, 30) }))));
check(Boolean(settled), 'the parent heard back');
check(posts.length === 3, 'three posts in the child', kid && kinds(kid));
const want = answers.map((a) => a.replyTo.join(',')).sort();
const got = replies.map((r) => r.re.join(',')).sort();
check(JSON.stringify(want) === JSON.stringify(got), 'one reply per child answer, re = the posts it answers', `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
if (!answers.some((a) => a.replyTo.length > 1)) console.log('(Pi answered each follow-up on its own; grouping not exercised)');

bot.close();
done();
