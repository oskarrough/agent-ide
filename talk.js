// A tool call's task id keys what it creates and posts, so a replay finds what it made the first time.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export function server(core) {
  const { agentName, agentOf, home, postEntry } = core;

  const post = defineTool({
    name: 'post',
    description: 'Post to another thread, or start a new child thread of this one by leaving out `thread`. '
      + 'Whoever answers, their answer comes to you here as a message, even mid-turn; don\'t read the thread to check for it.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number({ description: 'The thread to post to. Leave out to start a new one.' })),
      title: Type.Optional(Type.String({ description: 'The new thread\'s title' })),
      body: Type.String(),
      to: Type.Optional(Type.String({ description: 'Who should answer: an agent like model@runner or provider/model@runner, a runner for its default model, or "nobody". Leave out for whom the thread last asked; in a new thread, yourself.' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const { thread: from, name } = await home(api.conversationId);
      const key = `call:${api.taskId}`;
      if (args.thread === from) throw new Error('That is your own thread; just answer');
      // A replay would run it twice, and its output would never reach the agent.
      if (/^\$\s/.test(args.body)) throw new Error('Run commands with your own bash tool, not as a post');
      const id = args.thread ?? (await core.createThread(name, { title: args.title, parent: from }, key)).id;
      const to = args.to === undefined ? (args.thread === undefined ? { to: await agentOf(api.conversationId) } : {}) : { to: args.to === 'nobody' ? null : await named(args.to) };
      const posted = await postEntry(id, name, { body: args.body, ...to }, { key, from });
      const who = posted.to.map(agentName).join(', ') || 'nobody';
      return { content: [{ type: 'text', text: `Posted to thread ${id} for ${who}.${posted.to.length ? ' The answer will come to you here on its own; carry on, or end your turn.' : ''}` }], details: { thread: id } };
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

  async function named(name) {
    const at = name.lastIndexOf('@');
    const runner = name.slice(at + 1);
    const model = at < 0 ? '' : name.slice(0, at);
    if (!model || model.includes('/')) return core.address({ runner, model });
    const found = core.models.getProvider(`runner:${runner}`)?.getModels().find((m) => m.id.split('/').pop() === model);
    if (!found) throw new Error(`${runner} has no model ${model}; name it as provider/model@${runner}`);
    return core.address({ runner, model: found.id });
  }

  // An answer to posts goes back to each thread they came from, asking whoever posted, and steers in between tool calls.
  async function reply(posts, answeredIn, agent, body, key) {
    for (const from of new Set(posts.map((p) => p.data.from))) {
      const mine = posts.filter((p) => p.data.from === from);
      const conversation = (await core.thread(from)).agents[mine[0].data.author];
      const asker = conversation ? await agentOf(conversation) : null;
      await postEntry(from, agent, { body: body.slice(0, 8000), to: asker, steer: true }, { key: `re:${key}:${from}`, from: answeredIn, re: mine.map((p) => p.id) });
    }
  }

  return { extension: defineExtension({ name: 'agent-ide.talk', tools: [post, threads], sections: [section] }), reply };
}
