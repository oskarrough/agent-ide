// With memory, an agent asked late in a long thread gets one input that stays bounded: its newest messages whole, up
// to 64 KB, and everything older as the thread's memory lines, within 64 KB even while their pairs are not built yet.
// It can still zoom down to the first message.
import { api, check, conversationOf, done, linesOf, say, call, scriptedRunner, server, text, until, view } from './lib.js';

const never = new Promise(() => {});
const route = (request) => {
  const first = text(request.messages.find((m) => m.role === 'user'));
  if (first.includes('merge lines')) return never;
  if (first.includes('<input>')) return say(`L ${'x'.repeat(298)}`);
  return request.messages.some((m) => m.role === 'toolResult') ? say('done') : call('zoom', { id: 0, n: 1 });
};
const long = (k) => `message ${k} ${'y'.repeat(1000 - `message ${k} `.length)}`;

const srv = await server({ MEMORY: '1', MEMORY_MODEL: 'echo/echo@bot' });
await scriptedRunner('bot', route);
const { json: { id } } = await api('POST', '/api/threads', { title: 'late' });
for (let k = 0; k < 300; k++) await api('POST', `/api/threads/${id}/entries`, { body: long(k), to: null });
// Every message has its line, and no pair does: those lines alone are past 64 KB.
check(Boolean(await until(async () => (await linesOf(id)).length === 300, 60000, 500)), 'every message has its line');
await api('POST', `/api/threads/${id}/entries`, { body: 'catch up, please', to: { runner: 'bot', model: 'echo/echo' } });
const v = await until(async () => { const v = await view(id); return v.entries.some((e) => e.data.answer) && v; }, 30000);
const conversation = await conversationOf(v, 'echo/echo@bot');
const inputs = conversation.entries.filter((e) => e.kind === 'agent-ide.delivery').map((e) => text(e.model[0]));
const input = inputs[0] ?? '';
check(inputs.length === 1, 'the agent gets one input', inputs.length);
check(Buffer.byteLength(input) <= 128 * 1024, 'it stays within 64 KB whole and 64 KB of memory', Buffer.byteLength(input));
check(/\n\d+\+2\|\(not summarized yet: zoom it\)\n/.test(input), 'with pairs not built yet shown as not summarized', input.slice(0, 200));
check(input.startsWith('<chat>\n0+') && input.includes('</chat>'), 'it opens with the memory, from message 0', input.slice(0, 40));
check(input.endsWith(`oskar: ${long(299)}\n\noskar: catch up, please`), 'and ends with the newest messages whole');
const zoomed = conversation.entries.find((e) => e.kind === 'pi.tool-result');
check(text(zoomed?.model[0] ?? {}) === `oskar: ${long(0)}`, 'zoom still reaches message 0 whole');

srv.kill();
done();
