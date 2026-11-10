/**
 * A bot is one name in many threads: a home thread, the agent it joins as, instructions, and the hue it's shown in if
 * someone picked one. Ask `ada` anywhere and an
 * agent named ada joins as that; at home, hands off, it rewrites its own instructions with the `bot` tool. On by default;
 * MODULES=-bots turns it off.
 */
import { obj, opt, str } from '@earendil-works/pi-schema'
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AGENT, agentTo } from '../util.js'

export const on = true

/** A bot's name → { home, to, instructions, color? }: color is a hue someone picked */
const Bots = defineDoc({
	kind: 'agent-ide.bots',
	version: 1,
	scope: 'session',
	checkpointWhen: () => true,
	initial: () => ({}),
})
const HANDS_OFF = ['-write', '-edit', '-bash']

export function server(core) {
	const bots = () => core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Bots))))
	const list = async () => Object.entries(await bots()).map(([name, bot]) => ({ name, ...bot }))

	async function change({ name, to, instructions, color }) {
		if (typeof name !== 'string' || !/^[\w.-]{1,40}$/.test(name))
			throw new Error('A name is 1 to 40 letters, digits, _ . or -')
		if ((await core.known())[name]) throw new Error(`${name} is a runner; pick another name`)
		if (name === AGENT)
			throw new Error(`${AGENT} is what every thread calls its own; pick another name`)
		if (instructions !== undefined && typeof instructions !== 'string')
			throw new Error('instructions is text')
		if (
			color !== undefined &&
			color !== null &&
			!(Number.isFinite(color) && color >= 0 && color < 360)
		)
			throw new Error('color is a hue from 0 to 360, or null for the one it would have')
		if (to !== undefined) {
			const { name: _, ...agent } = await core.address(typeof to === 'string' ? agentTo(to) : to)
			to = agent
		}
		return { name, to, instructions, color }
	}
	async function write(tx, { name, to, instructions, color }) {
		const all = await tx.doc(Bots)
		if (!all[name]) {
			if (!to) throw new Error(`${name} is new: say what it runs as, to: model@runner`)
			const home = await core.startThread(tx, name, null, HANDS_OFF)
			all[name] = { home, to, instructions: instructions ?? '' }
		} else {
			if (to) all[name].to = to
			if (instructions !== undefined) all[name].instructions = instructions
		}
		if (color === null) delete all[name].color
		else if (color !== undefined) all[name].color = color
		return JSON.parse(JSON.stringify({ name, ...all[name] }))
	}

	async function serve(id, query, body) {
		if (id !== undefined) throw new Error('Bots live at /api/bots')
		if (body === undefined) return list()
		const asked = await change(body)
		return core.once(body.requestId, `bot ${asked.name}`, (tx) => write(tx, asked))
	}
	async function remove(name) {
		return core.commit(async (tx) => {
			const all = await tx.doc(Bots)
			if (!all[name]) throw Object.assign(new Error(`No bot ${name}`), { status: 404 })
			delete all[name]
			return { name }
		})
	}

	async function archiving(tx, threadId) {
		const [name] = Object.entries(await tx.doc(Bots)).find(([, bot]) => bot.home === threadId) ?? []
		if (name) throw new Error(`Thread ${threadId} is ${name}'s home; forget ${name} first`)
	}

	async function botAgent(name) {
		const bot = (await bots())[name]
		return bot && { ...bot.to, name }
	}

	/** What a bot is, in its own words; empty until it writes them */
	const instructionsOf = async (name) => (await bots())[name]?.instructions
	const botNames = async () => Object.keys(await bots())

	const bot = defineTool({
		name: 'bot',
		description:
			'Only for a bot, in its home thread. Leave out `name`, or give your own, to rewrite yourself: your instructions, ' +
			'which every agent of your name reads, or the model you join new threads with. A new name makes another bot, ' +
			'with its own home thread, from your model unless you give one.',
		parameters: obj({
			name: opt(str({ description: 'A new bot to make; leave out for yourself' })),
			instructions: opt(
				str({
					description:
						'The whole text: who the bot is, how it works, what it knows about the people it works with',
				}),
			),
			model: opt(str({ description: 'model@runner, as `pi --model` takes the model' })),
		}),
		replay: 'safe',
		execute: async (args, api) => {
			const at = await core.home(api.conversationId)
			const mine = at && (await bots())[at.name]
			if (!mine || mine.home !== at.thread) throw new Error('Only a bot can, in its home thread')
			const name = args.name ?? at.name
			if (name !== at.name && (await bots())[name])
				throw new Error(`${name} is another bot; it changes at its own home`)
			const own = await core.agentOf(api.conversationId)
			const asked = await change({
				name,
				instructions: args.instructions,
				to: args.model ?? (name === at.name ? undefined : { ...own, name: undefined }),
			})
			const made = await core.once(`bot ${api.taskId}`, 'bot', (tx) => write(tx, asked))
			return {
				output: [
					{
						type: 'text',
						text:
							name === at.name
								? 'Done: it counts from your next request.'
								: `Made ${name}, at home in thread ${made.home}.`,
					},
				],
			}
		},
	})

	const section = {
		key: 'bot',
		render: async ({ conversationId, agent, read }) => {
			const at = await core.home(conversationId)
			const all = at && ((await read.snapshot(Bots, context)) ?? {})
			const bot = all?.[at.name]
			if (!bot) return undefined
			const threads = (await core.threadList(at.name)).filter(
				(thread) =>
					thread.id !== at.thread && thread.agents.some((agent) => agent.name === at.name),
			)
			const where = threads.map(
				(thread) => `${thread.id} "${thread.title}"${thread.id === bot.home ? ' (home)' : ''}`,
			)
			const home = at.thread === bot.home
			const others = Object.keys(all).filter((name) => name !== at.name)
			return [
				bot.instructions ||
					(home
						? "You're new: you have no instructions yet. Find out with the person here who you are, and write it down with your bot tool."
						: ''),
				`You are the bot ${at.name}, one person in every thread you're in.${where.length ? ` You're also in thread${where.length > 1 ? 's' : ''} ${where.join(', ')}; read one when it matters, and post to one to speak there yourself.` : ''}`,
				others.length &&
					agent.tools.some((tool) => tool.name === 'post') &&
					`The other bot${others.length > 1 ? 's are' : ' is'} ${others.join(', ')}: post with \`to\` set to a name to ask one.`,
				home && 'This is your home. Ask before you change your model.',
			]
				.filter(Boolean)
				.join('\n\n')
		},
	}
	return {
		serve,
		remove,
		archiving,
		botAgent,
		instructionsOf,
		botNames,
		extension: defineExtension({ name: 'agent-ide.bots', tools: [bot], sections: [section] }),
	}
}
