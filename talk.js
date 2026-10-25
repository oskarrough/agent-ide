// A `post` call does everything in one commit, with a receipt keyed by its task id, so a replay finds it.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { messageText } from './remote.js';

export function server(core) {
  const { agentName, agentOf, home } = core;

  const post = defineTool({
    name: 'post',
    description: 'Post to another thread, or start a new child thread of this one by leaving out `thread`. '
      + 'Whoever answers, their answer comes to you here as a message, even mid-turn; don\'t read the thread to check for it.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number({ description: 'The thread to post to. Leave out to start a new one.' })),
      title: Type.Optional(Type.String({ description: 'The new thread\'s title' })),
      body: Type.String(),
      to: Type.Optional(Type.String({ description: 'Who should answer: model@runner, where model is anything `pi --model` takes, a runner for its default model, or "nobody". Leave out for whom the thread last asked; in a new thread, yourself.' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const { thread: from, name } = await home(api.conversationId);
      if (args.thread === from) throw new Error('That is your own thread; just answer');
      // A replay would run it twice, and its output would never reach the agent.
      if (/^\$\s/.test(args.body)) throw new Error('Run commands with your own bash tool, not as a post');
      const title = args.thread === undefined ? core.field(args.title, 'title') : '';
      if (args.thread !== undefined) await core.conversation(args.thread);
      const to = args.to === 'nobody' ? [] : args.to !== undefined ? [await core.address(core.agentTo(args.to))]
        : args.thread === undefined ? [await agentOf(api.conversationId)] : await core.lastAsked(args.thread);
      await core.reach(to, `@${core.agentTo(name).runner}`);
      const id = await core.once(`post ${api.taskId}`, 'post', async (tx) => {
        const id = args.thread ?? await core.startThread(tx, name, title, from);
        await core.post(tx, id, { author: name, body: args.body, ...(to.length ? { to } : {}), from }, { empty: args.thread === undefined });
        return id;
      });
      const who = to.map(agentName).join(', ') || 'nobody';
      return { output: [{ type: 'text', text: `Posted to thread ${id} for ${who}.${to.length ? ' The answer will come to you here on its own; carry on, or end your turn.' : ''}` }], details: { thread: id } };
    },
  });

  // Not `read`: a tool of that name would replace Pi's own.
  const threads = defineTool({
    name: 'threads',
    description: 'Read a thread\'s latest entries, or those that contain `query`, or list every thread by leaving out both. '
      + 'With `agent`, read that agent\'s own work in the thread instead: what it was handed, the tool calls it made and what they printed, word for word. '
      + 'Answers to your own posts come to you; no need to read for them.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number({ description: 'With `query` or `agent`, your own thread by default' })),
      agent: Type.Optional(Type.String({ description: 'An agent in that thread, as model@runner or any unique part of it' })),
      last: Type.Optional(Type.Number({ description: 'How many entries, 20 by default' })),
      query: Type.Optional(Type.String({ description: 'Only entries containing this text, ignoring case' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const { thread: mine, name } = await home(api.conversationId);
      const lines = [];
      if (args.agent !== undefined) return { output: [{ type: 'text', text: await work(args.thread ?? mine, args) }] };
      if (args.thread === undefined && args.query === undefined) {
        for (const row of await core.threadList(name)) {
          const parts = [`#${row.id} ${row.title}`, row.parent && `child of #${row.parent}`, row.agents.map((a) => a.name).join(' '), row.status, row.id === mine && '(yours)'];
          lines.push(parts.filter(Boolean).join(', '));
        }
      } else {
        const query = args.query?.toLowerCase();
        const found = (await core.messages(args.thread ?? mine)).filter((e) => !query || core.said(e).toLowerCase().includes(query));
        for (const { id, data: m } of found.slice(-(args.last ?? 20))) {
          lines.push(`#${id} ${m.author}${m.from ? ` from thread ${m.from}` : ''}${m.to ? ` to ${m.to.map(agentName).join(', ')}` : ''}: ${m.body.slice(0, 2000)}`);
        }
      }
      return { output: [{ type: 'text', text: lines.join('\n') || (args.query ? 'No entry contains it.' : 'Nothing yet.') }] };
    },
  });

  // An agent's own conversation as lines: what it was handed, what it said, each call and what it printed.
  async function work(threadId, { agent, query, last = 20 }) {
    const { agents } = await core.thread(threadId);
    const names = Object.keys(agents);
    const found = names.includes(agent) ? [agent] : names.filter((n) => n.includes(agent));
    if (found.length !== 1) throw new Error(`${found.length ? 'Several' : 'No'} agents in thread ${threadId} match ${agent}: ${(found.length ? found : names).join(', ') || 'none'}`);
    const lines = [];
    for (const { id, model = [] } of await core.entries(agents[found[0]])) {
      for (const m of model) {
        if (m.role === 'user') lines.push(`#${id} handed: ${messageText(m)}`);
        if (m.role === 'toolResult') lines.push(`#${id} ${m.toolName}${m.isError ? ' failed' : ''}: ${messageText(m)}`);
        if (m.role === 'assistant') for (const part of m.content) {
          if (part.type === 'text' && part.text) lines.push(`#${id} said: ${part.text}`);
          if (part.type === 'toolCall') lines.push(`#${id} called ${part.name} ${JSON.stringify(part.arguments)}`);
        }
      }
    }
    const shown = lines.filter((l) => !query || l.toLowerCase().includes(query.toLowerCase())).slice(-last)
      .map((l) => l.length > 4000 ? `${l.slice(0, 4000)}… (${l.length - 4000} more characters; narrow it with query)` : l);
    return shown.join('\n') || (query ? 'Nothing in its work contains it.' : `${found[0]} has done nothing here yet.`);
  }

  const section = {
    key: 'talk',
    tag: false,
    render: () => 'A message from another thread says which. To wait for an answer from another thread, end your turn: the answer wakes you. Don\'t sleep or poll.',
  };

  // An answer to posts goes back to each thread they came from, asking every agent there who posted.
  async function reply(posts, answeredIn, agent, body) {
    const replies = [];
    for (const from of new Set(posts.map((p) => p.data.from))) {
      const mine = posts.filter((p) => p.data.from === from);
      const { agents } = await core.thread(from);
      const askers = (await Promise.all([...new Set(mine.map((p) => agents[p.data.author]))].filter(Boolean).map(agentOf))).filter(Boolean);
      replies.push({ thread: from, data: { author: agent, body: body.slice(0, 8000), ...(askers.length ? { to: askers } : {}), from: answeredIn, re: mine.map((p) => p.id) } });
    }
    return replies;
  }

  return { extension: defineExtension({ name: 'agent-ide.talk', tools: [post, threads], sections: [section] }), reply };
}
