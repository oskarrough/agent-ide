// With memory, when Pi compacts an agent's conversation, its summary is the thread's memory up to the cut: lines
// covering every message the agent had been given, coarse when old, within 64 KB. No model writes a prose summary.
import { answered, api, check, conversationOf, done, linesOf, say, scriptedRunner, server, text, until } from './lib.js';

const requests = [];
const route = (request) => {
  const all = request.messages.map((m) => text(m)).join('\n');
  requests.push(all);
  const first = text(request.messages.find((m) => m.role === 'user'));
  return say(first.includes('<input>') ? `L ${'x'.repeat(298)}` : 'ok');
};
const filler = (k) => `filler ${k} ${'z'.repeat(500 - `filler ${k} `.length)}`;
const agent = { runner: 'bot', model: 'echo/echo' };

const srv = await server({ MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' });
await scriptedRunner('bot', route, { model: { contextWindow: 40000 } });
const { json: { id } } = await api('POST', '/api/threads', { title: 'long' });

let k = 0;
for (; k < 140; k++) await api('POST', `/api/threads/${id}/entries`, { body: filler(k), to: null });
await api('POST', `/api/threads/${id}/entries`, { body: 'go A', to: agent });
await answered(id, 1, 20000);
for (; k < 310; k++) await api('POST', `/api/threads/${id}/entries`, { body: filler(k), to: null });
// 312 messages with A's answer: every leaf, and every pair under the 141 A held, so the memory can merge them.
const built = await until(async () => {
  const ls = await linesOf(id);
  return ls.filter((x) => x.l === 0).length === 312 && ls.filter((x) => x.l === 1 && x.i < 70).length === 70;
}, 60000, 500);
check(Boolean(built), 'every message has its line');
await api('POST', `/api/threads/${id}/entries`, { body: 'go B', to: agent });
const v = await answered(id, 2, 60000);

const conversation = await conversationOf(v, 'echo/echo@bot');
const compaction = conversation?.entries.find((e) => e.kind === 'pi.compaction');
const summary = compaction ? text(compaction.model?.[0]) || JSON.stringify(compaction.data) : '';
check(summary.includes('<chat>'), 'the agent\'s conversation is compacted, with the memory as its summary', JSON.stringify(compaction)?.slice(0, 300));
const chat = summary.slice(summary.indexOf('<chat>\n') + 7, summary.indexOf('\n</chat>'));
const heads = chat.split('\n').map((l) => l.match(/^(\d+)\+(\d+)\|/)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
const contiguous = heads.every(([at, n], j) => at === (j ? heads[j - 1][0] + heads[j - 1][1] : 0));
check(contiguous && heads.reduce((s, [, n]) => s + n, 0) === 141, 'its lines cover positions 0 to 140 exactly', JSON.stringify(heads.slice(0, 5)) + '…' + JSON.stringify(heads.slice(-3)));
check(heads.length > 0 && heads[0][1] > heads.at(-1)[1], 'old lines are coarser than recent ones', JSON.stringify([heads[0], heads.at(-1)]));
check(Buffer.byteLength(chat) <= 65536, 'the memory fits in 64 KB', Buffer.byteLength(chat));
check(!requests.some((r) => r.includes('context summarization assistant')), 'Pi\'s summariser never ran');

srv.kill();
done();
