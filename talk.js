// A `post` call does everything in one commit, keyed by its task id in the poster's thread, so a replay finds it.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export function server(core) {
  const { Thread, agentName, agentOf, home } = core;

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
    execute: async (args, api, context) => {
      const { thread: from, name } = await home(api.conversationId);
      if (args.thread === from) throw new Error('That is your own thread; just answer');
      // A replay would run it twice, and its output would never reach the agent.
      if (/^\$\s/.test(args.body)) throw new Error('Run commands with your own bash tool, not as a post');
      const title = args.thread === undefined ? core.field(args.title, 'title') : '';
      if (args.thread !== undefined) await core.conversation(args.thread);
      const to = args.to === 'nobody' ? [] : args.to !== undefined ? [await named(args.to)]
        : args.thread === undefined ? [await agentOf(api.conversationId)] : await core.lastAsked(args.thread);
      const id = await api.commit(async (tx) => {
        const sent = (await tx.doc(Thread, from)).sent;
        if (sent[api.taskId]) return sent[api.taskId];
        const id = args.thread ?? await core.startThread(tx, name, title, from);
        await core.post(tx, id, { author: name, body: args.body, ...(to.length ? { to } : {}), from }, { empty: args.thread === undefined });
        return sent[api.taskId] = id;
      }, context);
      const who = to.map(agentName).join(', ') || 'nobody';
      return { content: [{ type: 'text', text: `Posted to thread ${id} for ${who}.${to.length ? ' The answer will come to you here on its own; carry on, or end your turn.' : ''}` }], details: { thread: id } };
    },
  });

  // Not `read`: a tool of that name would replace Pi's own.
  const threads = defineTool({
    name: 'threads',
    description: 'Read a thread\'s latest entries, or list every thread by leaving out `thread`. Answers to your own posts come to you; no need to read for them.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number()),
      last: Type.Optional(Type.Number({ description: 'How many entries, 20 by default' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const { thread: mine, name } = await home(api.conversationId);
      const lines = [];
      if (args.thread === undefined) {
        for (const row of await core.threadList(name)) {
          const parts = [`#${row.id} ${row.title}`, row.parent && `child of #${row.parent}`, row.agents.map((a) => a.name).join(' '), row.status, row.id === mine && '(yours)'];
          lines.push(parts.filter(Boolean).join(', '));
        }
      } else {
        for (const { id, data: m } of (await core.messages(args.thread)).slice(-(args.last ?? 20))) {
          lines.push(`#${id} ${m.author}${m.from ? ` from thread ${m.from}` : ''}${m.to ? ` to ${m.to.map(agentName).join(', ')}` : ''}: ${m.body.slice(0, 2000)}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'Nothing yet.' }] };
    },
  });

  const section = {
    key: 'talk',
    tag: false,
    render: () => 'A message from another thread says which. To wait for an answer from another thread, end your turn: the answer wakes you. Don\'t sleep or poll.',
  };

  // `model@runner`, or a bare runner for its default model.
  function named(name) {
    const at = name.lastIndexOf('@');
    return core.address({ runner: name.slice(at + 1), model: at < 0 ? '' : name.slice(0, at) });
  }

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
