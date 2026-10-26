// MODULES=+bots: a bot is a name that's in many threads as one person. Its home is a thread, where the agent of its
// name holds its recipe, and its instructions are its own. Asked by name in any other thread, an agent of that name
// joins there the usual way, made from the home agent's recipe; name=model@runner gives that thread another model.
// Every agent of a bot's name reads the bot's instructions before each request, so an edit counts from the next one,
// and is told which other threads it's in, to read one with talk's `threads` when it matters.
//   POST /api/threads/:id/bots {name, instructions}: this thread is the bot's home. GET: every bot.
import { defineDoc, defineExtension } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

// A bot's name → { home: its thread, instructions }.
const Bots = defineDoc({
	kind: 'agent-ide.bots',
	version: 1,
	scope: 'session',
	checkpointWhen: () => true,
	initial: () => ({}),
})

export function server(core) {
	const bots = () => core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Bots))))

	async function serve(id, query, body) {
		await core.conversation(id)
		if (body === undefined)
			return Object.entries(await bots()).map(([name, bot]) => ({ name, ...bot }))
		const { name, instructions = '' } = body
		if (typeof name !== 'string' || !/^[\w.-]{1,40}$/.test(name))
			throw new Error('A name is 1 to 40 letters, digits, _ . or -')
		if ((await core.known())[name]) throw new Error(`${name} is a runner; pick another name`)
		if (typeof instructions !== 'string') throw new Error('instructions is text')
		return core.commit(async (tx) => {
			const all = await tx.doc(Bots)
			if (all[name] && all[name].home !== id)
				throw new Error(`${name}'s home is thread ${all[name].home}`)
			all[name] = { home: id, instructions }
			return { name, ...all[name] }
		})
	}

	// A bot's name in a thread without it: the home agent's recipe, under the bot's name.
	async function recipe(name) {
		const bot = (await bots())[name]
		if (!bot) return undefined
		const agent = (await core.thread(bot.home))?.agents[name]
		if (!agent) throw new Error(`${name} has no agent at home in thread ${bot.home} yet: ask ${name}=model@runner there`)
		return { ...(await core.agentOf(agent.conversation, name)), name }
	}

	const section = {
		key: 'bot',
		render: async ({ conversationId, read }) => {
			const at = await core.home(conversationId)
			const bot = at && (await read.snapshot(Bots, context))?.[at.name]
			if (!bot) return undefined
			const threads = (await core.threadList(at.name)).filter(
				(t) => t.id !== at.thread && t.agents.some((a) => a.name === at.name),
			)
			const where = threads.map((t) => `${t.id} "${t.title}"${t.id === bot.home ? ' (home)' : ''}`)
			return [
				bot.instructions,
				`You are the bot ${at.name}, one person in every thread you're in.${where.length ? ` You're also in thread${where.length > 1 ? 's' : ''} ${where.join(', ')}; read one when it matters.` : ''}`,
			]
				.filter(Boolean)
				.join('\n\n')
		},
	}
	return { serve, recipe, extension: defineExtension({ name: 'agent-ide.bots', sections: [section] }) }
}
