// A browser watching a thread hears a snapshot, then the agent's reply stream in and its tool call start and end, all
// before the answer lands in the thread. Watching again, as after a reconnect or a restart, starts from a fresh snapshot.
import { answered, api, base, call, check, done, say, scriptedRunner, server, sleep, until } from './lib.js';

let srv = await server();
const long = `done ${'and more '.repeat(60)}`;
const bot = await scriptedRunner('bot', (request) => request.messages.some((m) => m.role === 'toolResult')
  ? say(long) : call('bash', { command: 'sleep 1; echo slept' }));
const { json: { id } } = await api('POST', '/api/threads', { title: 'live' });

// Every message the socket hears for the thread, in order: `{agent?, events}`.
function watch(thread) {
  const heard = [];
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.thread === thread) heard.push(m); };
  socket.onopen = () => socket.send(JSON.stringify({ watch: thread }));
  return { heard, close: () => socket.close() };
}
const flat = (heard) => heard.flatMap((m) => m.events.map((e) => ({ ...e, who: m.agent })));
const answerAt = (events) => events.findIndex((e) => !e.who && e.type === 'entry_appended' && e.entry.data?.answer);

const first = watch(id);
await until(async () => first.heard.length);
check(first.heard[0]?.events[0]?.type === 'snapshot' && !first.heard[0].agent, 'the thread\'s snapshot comes first', JSON.stringify(first.heard[0]));

await api('POST', `/api/threads/${id}/entries`, { body: 'work', to: { runner: 'bot', model: 'echo/echo' } });
// Joining mid-run, the agent's snapshot holds its run and the tool call in it.
await until(async () => flat(first.heard).some((e) => e.type === 'tool_execution_start'), 8000, 20);
const late = watch(id);
const joined = await until(async () => late.heard.find((m) => m.agent)?.events[0], 8000, 20);
check(joined?.type === 'snapshot' && joined.run && joined.tools.some((t) => t.name === 'bash' && t.status === 'running'), 'joining mid-run, the agent\'s snapshot shows its running tool call', JSON.stringify(joined)?.slice(0, 300));
late.close();
await answered(id);
const events = await until(async () => answerAt(flat(first.heard)) >= 0 && flat(first.heard));
const at = answerAt(events ?? []);
const agent = (events ?? []).filter((e, i) => e.who === 'echo/echo@bot' && i < at);
check(agent[0]?.type === 'snapshot', 'the agent\'s stream starts with its own snapshot', JSON.stringify(agent[0]));
check(agent.some((e) => e.type === 'tool_execution_start' && e.toolName === 'bash' && e.args.command?.includes('sleep'))
  && agent.some((e) => e.type === 'tool_execution_end' && e.toolName === 'bash'), 'its tool call starts and ends before the answer lands');
// The reply as a client rebuilds it: the partial its message_start carries, then the text its updates add.
const reply = agent.slice(agent.findLastIndex((e) => e.type === 'message_start' && e.message.role === 'assistant'));
const streamed = [...reply[0]?.message.content.map((b) => b.text ?? '') ?? [], ...reply.filter((e) => e.type === 'message_update').flatMap((e) => e.changes)
  .map((c) => c.type === 'text_start' ? c.block.text : c.type === 'text_delta' ? c.delta : '')].join('');
check(reply.filter((e) => e.type === 'message_update').length > 1 && streamed.length > 20 && long.startsWith(streamed),
  'its reply streams in, in several updates, before the answer lands', JSON.stringify(streamed.slice(0, 80)));
check(events?.[at]?.entry.data.body === long, 'then the answer lands in the thread');
check(!agent.some((e) => e.entries?.length), 'an agent\'s snapshot leaves its entries out');
first.close();

const again = watch(id);
await until(async () => again.heard.length);
const snapshot = again.heard[0]?.events[0];
check(snapshot?.type === 'snapshot' && snapshot.entries.some((e) => e.data?.answer), 'watching again starts from a fresh snapshot with the answer in it');
again.close();

// A restart closes the socket; watching the new server gives a snapshot of everything kept.
srv.kill('SIGKILL');
await sleep(500);
srv = await server();
const restarted = watch(id);
await until(async () => restarted.heard.length);
check(restarted.heard[0]?.events[0]?.entries?.filter((e) => e.kind === 'agent-ide.message').length === 2, 'after a restart, watching again gets the whole thread');
restarted.close();
bot.close();
done();
