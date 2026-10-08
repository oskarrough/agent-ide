// A tool call's task id keys what it creates and posts, so a replay finds what it made the first time.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { messageText } from './remote.js';

export function server(core) {
  const { agentName, agentOf, postEntry } = core;

  const post = defineTool({
    name: 'post',
    description: 'Post to another thread, or start a new child thread of this one by leaving out `thread`. '
      + 'Whoever answers, their answer comes to you here as a message, even mid-turn; don\'t read the thread to check for it.',
    parameters: Type.Object({
      thread: Type.Optional(Type.Number({ description: 'The thread to post to. Leave out to start a new one.' })),
      title: Type.Optional(Type.String({ description: 'The new thread\'s title' })),
      body: Type.String(),
      to: Type.Optional(Type.String({ description: 'Who should answer: an agent like model@runner or provider/model@runner, a runner for its default model, or "nobody". Leave out for the thread\'s agent; in a new thread, yourself.' })),
    }),
    replay: 'safe',
    execute: async (args, api) => {
      const from = api.conversationId;
      const me = await agentOf(from);
      const key = `call:${api.taskId}`;
      if (args.thread === from) throw new Error('That is your own thread; just answer');
      // A replay would run it twice, and its output would never reach the agent.
      if (/^\$\s/.test(args.body)) throw new Error('Run commands with your own bash tool, not as a post');
      const id = args.thread ?? (await core.createThread(agentName(me), { title: args.title, parent: from }, key)).id;
      const to = args.to === undefined ? (args.thread === undefined ? { to: me } : {}) : { to: args.to === 'nobody' ? null : await named(args.to) };
      const posted = await postEntry(id, agentName(me), { body: args.body, ...to }, { key, from });
      const who = posted?.to ? agentName(posted.to) : 'nobody';
      return { content: [{ type: 'text', text: `Posted to thread ${id} for ${who}.${posted?.to ? ' Its answer will come to you here on its own; carry on, or end your turn.' : ''}` }], details: { thread: id } };
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
      const me = agentName(await agentOf(api.conversationId));
      const lines = [];
      if (args.thread === undefined) {
        for (const row of await core.threadList(me)) {
          const parts = [`#${row.id} ${row.title}`, row.parent && `child of #${row.parent}`, row.agent && agentName(row.agent), row.status, row.id === api.conversationId && '(yours)'];
          lines.push(parts.filter(Boolean).join(', '));
        }
      } else {
        const entries = await core.entries(args.thread);
        for (const { author, to, from, body, entry } of entries.filter((e) => e.entry.kind !== 'pi.system').slice(-(args.last ?? 20))) {
          const text = body ?? (messageText(entry.model?.[0]) || entry.data?.text || (entry.data?.command ? `$ ${entry.data.command}` : ''));
          const content = entry.model?.[0]?.content;
          const calls = Array.isArray(content) ? content.filter((p) => p.type === 'toolCall').map((p) => ` [${p.name} ${JSON.stringify(p.arguments)}]`).join('') : '';
          lines.push(`#${entry.id} ${author}${from ? ` from thread ${from}` : ''}${to ? ` to ${agentName(to)}` : ''}: ${text.slice(0, 2000)}${calls}`);
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

  // It steers, so a working agent reads it between tool calls. If another agent has the thread now, or the post was
  // withdrawn before it had an entry, it lands as a note.
  async function reply(threadId, answeredIn, agent, body, posts, postKey) {
    const text = body.slice(0, 8000);
    const key = `re:${posts.join(',') || postKey}`;
    if (posts.length) {
      try {
        return await postEntry(threadId, agent, { body: text, to: await agentOf(threadId), steer: true }, { key, from: answeredIn, re: posts });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    const said = `${core.heading({ author: agent, from: answeredIn, re: posts })}${text}`;
    await core.write(threadId, { kind: 'agent-ide.note', data: { author: agent, text: `${said} → thread:${answeredIn}`, thread: answeredIn }, model: [core.userMessage(said)] }, key);
  }

  return { extension: defineExtension({ name: 'agent-ide.talk', tools: [post, threads], sections: [section] }), reply };
}
