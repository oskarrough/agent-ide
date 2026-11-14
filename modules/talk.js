/**
 * Gives agents `post`, to ask another thread or answer one, and `threads`, to read any thread or any agent's work (experimental).
 * On by default; MODULES=-talk turns it off.
 * A `post` call does everything in one commit, with a receipt keyed by its task id, so a replay finds it.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { messageText } from '../remote.js'
import { AGENT, writtenTo, field, keyOf, said, mentioned } from '../util.js'

export const on = true

export function server(core) {
	const { agentOf, home } = core
	const answered = async (thread, by) =>
		new Set(
			(await core.messages(thread))
				.filter((entry) => entry.data.from === by)
				.flatMap((entry) => entry.data.re ?? []),
		)

	const post = defineTool({
		name: 'post',
		description:
			'Ask someone. Leave out `thread` for a side question: a new child thread that holds only what you write; a bot starting one for other bots is in it and speaks there as itself. ' +
			'Give a `thread` to ask whoever is there, with all they already know there. Posting to a thread that asked you something answers it. ' +
			"A thread you start answers you here on its own, even mid-turn; don't read it to check. Any other thread answers only if its agent posts back. " +
			"A bot posting to a thread it's in speaks there as itself instead, and replies stay there. " +
			'People see posts folded, as agent-to-agent talk; anything a person must know or do, say plainly in your own reply to them.',
		parameters: obj({
			thread: opt(num({ description: 'The thread to post to. Leave out to start a new one.' })),
			title: opt(str({ description: "The new thread's title" })),
			body: str(),
			to: opt(
				str({
					description:
						"Who should answer. A bot by its name. From anywhere, 12 is thread 12's agent and 12/ada a bot there, which also picks the thread. " +
						"Or model@runner, where model is anything `pi --model` takes, or a runner alone for its default model: it starts the thread's agent as that, or switches the one there, which keeps its conversation. " +
						'Or "nobody". Leave out for whom the thread last asked, or whom its director picks; in a new thread, yourself.',
				}),
			),
		}),
		replay: 'safe',
		execute: async (args, api, context) => {
			const saved = await core.receipt(`post ${api.taskId}`, 'post')
			if (saved) return saved.result
			const { thread: from, name } = await home(api.conversationId)
			const thread = args.thread ?? (Number(args.to?.match(/^(\d+)(?:\/|$)/)?.[1]) || undefined)
			if (thread === from) throw new Error('That is your own thread; just answer')
			if (/^\$\s/.test(args.body))
				throw new Error('Run commands with your own bash tool, not as a post')
			const title = thread === undefined ? field(args.title, 'title') : ''
			if (thread !== undefined) await core.conversation(thread)
			/** A bot that's in the thread speaks there as itself, like a person in the room: no question from home, no answer back */
			const member =
				thread !== undefined &&
				keyOf(name) !== AGENT &&
				Boolean((await core.thread(thread)).agents[keyOf(name)])
			if (member) {
				const { to, picked } = await core.recipients(
					thread,
					{ author: name, body: args.body },
					{
						explicit:
							args.to === undefined
								? undefined
								: async () =>
										args.to === 'nobody'
											? []
											: [await core.whom(thread, args.to, false, context.abortSignal)],
						fallback: async () =>
							(await core.lastAsked(thread)).filter((agent) => agent?.name !== name),
					},
				)
				return core.once(`post ${api.taskId}`, 'post', async (tx) => {
					context.abortSignal?.throwIfAborted()
					await core.post(
						tx,
						thread,
						{
							author: name,
							body: args.body,
							...(to.length ? { to } : {}),
							...(picked ? { picked } : {}),
						},
						{ steer: true, member: true },
					)
					return {
						output: [
							{
								type: 'text',
								text: `Said in thread ${thread}, where you're a member${to.length ? `, for ${to.map(writtenTo).join(', ')}` : ''}. Replies stay there, with your run in that thread; read it when you need them.`,
							},
						],
						details: { thread },
					}
				})
			}
			/**
			 * A bot that starts a thread for two or more other bots, named by `to` or @mention, is in it from the first
			 * message, as someone opening a group chat; a side question to one bot, a model or itself still asks from home.
			 */
			const bots = thread === undefined && keyOf(name) !== AGENT ? await core.botNames() : []
			const botNamed = (text) =>
				bots.find(
					(bot) => bot.toLowerCase() === text.replace(/^@/, '').replace(/\.+$/, '').toLowerCase(),
				)
			const named = [
				...(args.to !== undefined ? [botNamed(args.to)] : []),
				...mentioned(args.body, bots),
			].filter((bot) => bot && bot !== name)
			if (new Set(named).size > 1 && (args.to === undefined || botNamed(args.to))) {
				const to = await Promise.all(
					[...new Set(named)].map((bot) => core.whom(undefined, bot, false, context.abortSignal)),
				)
				const opener = await core.botAgent(name)
				return core.once(`post ${api.taskId}`, 'post', async (tx) => {
					context.abortSignal?.throwIfAborted()
					const id = await core.startThread(tx, title, from)
					await core.post(
						tx,
						id,
						{ author: name, body: args.body, ...(to.length ? { to } : {}) },
						{ empty: true, steer: true, opener },
					)
					return {
						output: [
							{
								type: 'text',
								text: `Started thread ${id}, where you're a member${to.length ? `, for ${to.map(writtenTo).join(', ')}` : ''}. Replies stay there, with your run in that thread; read it when you need them.`,
							},
						],
						details: { thread: id },
					}
				})
			}
			const done = thread !== undefined && (await answered(thread, from))
			const asked =
				thread === undefined
					? undefined
					: (await core.messages(from)).findLast(
							(entry) => entry.data.from === thread && !entry.data.re && !done.has(entry.id),
						)
			const askerKey = asked && keyOf(asked.data.author)
			const asker =
				asked &&
				(await agentOf((await core.thread(thread)).agents[askerKey]?.conversation, askerKey))
			/** An answer goes back to its asker; any other post to a thread asks the bots it @mentions there, or with no `to`, whom the director picks */
			const { to, picked } = await core.recipients(
				thread,
				{ author: name, body: args.body },
				{
					director: thread !== undefined && !asked,
					explicit:
						args.to === undefined
							? undefined
							: async () =>
									args.to === 'nobody'
										? []
										: [await core.whom(thread, args.to, false, context.abortSignal)],
					fallback: async () =>
						thread === undefined
							? [await agentOf(api.conversationId)]
							: asker
								? [asker]
								: await core.lastAsked(thread),
				},
			)
			/** Only a thread you started answers you on its own */
			const child = thread === undefined || (await core.thread(thread)).parent === from
			return core.once(`post ${api.taskId}`, 'post', async (tx) => {
				context.abortSignal?.throwIfAborted()
				const id = thread ?? (await core.startThread(tx, title, from))
				await core.post(
					tx,
					id,
					{
						author: name,
						body: args.body,
						...(to.length ? { to } : {}),
						from,
						...(asked ? { re: [asked.id] } : {}),
						...(picked ? { picked } : {}),
					},
					// Like a person's Enter, a post joins the run its agent is in, as answers coming back do
					{ empty: thread === undefined, steer: true },
				)
				// An answer was said here too: its own thread shows it, and its agent never reads it back
				if (asked) await core.post(tx, from, { author: name, body: args.body, re: [asked.id] })
				const who = to.map(writtenTo).join(', ') || 'nobody'
				if (asked)
					return {
						output: [{ type: 'text', text: `Answered thread ${id}'s question, for ${who}.` }],
						details: { thread: id },
					}
				return {
					output: [
						{
							type: 'text',
							text: `Posted to thread ${id} for ${who}.${!to.length ? '' : child ? ' The answer will come to you here on its own; carry on, or end your turn with no text: any text you end with is posted.' : " It isn't your child, so an answer comes only if its agent posts back."}`,
						},
					],
					details: { thread: id },
				}
			})
		},
	})

	const threads = defineTool({
		name: 'threads',
		description:
			"Read a thread's latest entries, or those that contain `query`, or list every thread by leaving out both. " +
			"With `agent`, read that agent's own work in the thread instead: what it was handed, the tool calls it made and what they printed, word for word. " +
			'Answers from threads you started come to you; no need to read for them.',
		parameters: obj({
			thread: opt(num({ description: 'With `query` or `agent`, your own thread by default' })),
			agent: opt(
				str({
					description:
						"An agent in that thread: a bot by its name, or the thread's agent as model@runner or `agent`, or any unique part of either; or thread/name",
				}),
			),
			last: opt(num({ description: 'How many entries, 20 by default' })),
			query: opt(str({ description: 'Only entries containing this text, ignoring case' })),
		}),
		replay: 'safe',
		execute: async (args, api) => {
			const { thread: mine, name } = await home(api.conversationId)
			const lines = []
			if (args.agent !== undefined) {
				const [, at, agent = args.agent] = args.agent.match(/^(\d+)\/(.+)$/) ?? []
				const text = await work(Number(at) || args.thread || mine, { ...args, agent })
				return { output: [{ type: 'text', text }] }
			}
			if (args.thread === undefined && args.query === undefined) {
				for (const row of await core.threadList(name)) {
					const parts = [
						`#${row.id} ${row.title}`,
						row.parent && `child of #${row.parent}`,
						row.agents.map((agent) => agent.name).join(' '),
						row.status,
						row.id === mine && '(yours)',
					]
					lines.push(parts.filter(Boolean).join(', '))
				}
			} else {
				const query = args.query?.toLowerCase()
				const found = (await core.messages(args.thread ?? mine)).filter(
					(entry) => !query || said(entry).toLowerCase().includes(query),
				)
				for (const { id, data: message } of found.slice(-(args.last ?? 20))) {
					lines.push(
						`#${id} ${message.author}${message.from ? ` from thread ${message.from}` : ''}${message.to ? ` to ${message.to.join(', ')}` : ''}: ${message.body.slice(0, 2000)}`,
					)
				}
			}
			return {
				output: [
					{
						type: 'text',
						text: lines.join('\n') || (args.query ? 'No entry contains it.' : 'Nothing yet.'),
					},
				],
			}
		},
	})

	async function work(threadId, { agent, query, last = 20 }) {
		const { agents } = await core.thread(threadId)
		/** The thread's agent goes by its key and by the model it runs as now */
		const candidates = await Promise.all(
			Object.entries(agents).map(async ([key, { conversation }]) => [
				key === AGENT ? writtenTo(await agentOf(conversation, key)) : key,
				key,
				conversation,
			]),
		)
		const names = candidates.map(([name]) => name)
		const exact = candidates.filter(([name, key]) => name === agent || key === agent)
		const found = exact.length ? exact : candidates.filter(([name]) => name.includes(agent))
		if (found.length !== 1)
			throw new Error(
				`${found.length ? 'Several' : 'No'} agents in thread ${threadId} match ${agent}: ${(found.length ? found.map(([name]) => name) : names).join(', ') || 'none'}`,
			)
		const [[shownName, , conversation]] = found
		const lines = []
		for (const { id, model = [] } of await core.entries(conversation)) {
			for (const message of model) {
				if (message.role === 'user') lines.push(`#${id} handed: ${messageText(message)}`)
				if (message.role === 'toolResult')
					lines.push(
						`#${id} ${message.toolName}${message.isError ? ' failed' : ''}: ${messageText(message)}`,
					)
				if (message.role === 'assistant')
					for (const part of message.content) {
						if (part.type === 'text' && part.text) lines.push(`#${id} said: ${part.text}`)
						if (part.type === 'toolCall')
							lines.push(`#${id} called ${part.name} ${JSON.stringify(part.arguments)}`)
					}
			}
		}
		const shown = lines
			.filter((line) => !query || line.toLowerCase().includes(query.toLowerCase()))
			.slice(-last)
			.map((line) =>
				line.length > 4000
					? `${line.slice(0, 4000)}… (${line.length - 4000} more characters; narrow it with query)`
					: line,
			)
		return (
			shown.join('\n') ||
			(query ? 'Nothing in its work contains it.' : `${shownName} has done nothing here yet.`)
		)
	}

	const section = {
		key: 'talk',
		tag: false,
		render: () =>
			"Answers to your posts wake you, even mid-turn: while you wait for one, end your turn with no text, and don't sleep or poll.",
	}

	async function reply(posts, answeredIn, agent, body) {
		const replies = []
		for (const from of new Set(posts.map((post) => post.data.from))) {
			const done = await answered(from, answeredIn)
			const mine = posts.filter((post) => post.data.from === from && !done.has(post.id))
			if (!mine.length) continue
			const { agents } = await core.thread(from)
			const askers = (
				await Promise.all(
					[...new Set(mine.map((post) => keyOf(post.data.author)))]
						.filter((key) => agents[key])
						.map((key) => agentOf(agents[key].conversation, key)),
				)
			).filter(Boolean)
			replies.push({
				thread: from,
				data: {
					author: agent,
					body: body.slice(0, 8000),
					...(askers.length ? { to: askers } : {}),
					from: answeredIn,
					re: mine.map((post) => post.id),
				},
			})
		}
		return replies
	}

	return {
		extension: defineExtension({
			name: 'agent-ide.talk',
			tools: [post, threads],
			sections: [section],
		}),
		reply,
	}
}
