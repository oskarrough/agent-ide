/** A scratch agent-ide to click through: its own store and port, a scripted runner `bot`, and one thread it has already answered.
 * The bots and director modules are on, with three bots, ada, bram and cleo, that answer at once, each naming itself, its
 * persona and what it was shown last, so who answered and what they saw read off the reply. Send to one by name (`--to ada`).
 * The director picks too: in a thread of bots, a message naming no one goes to whoever's persona it mentions (review,
 * engineer, design), else nobody.
 * `node scripts/try.js &`, open the address it prints, stop it with the `kill` line it prints. Every server it starts goes with it.
 * The bot's model, echo/echo, thinks, writes, reads, edits and runs a command in its folder, then answers in markdown.
 * A message with "post" in it makes it post to a new thread too, or to a bot it names; "slow" makes the command take five seconds, to watch live work, and passes on to the thread it posts to. */
import {
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
	api,
	base,
	call,
	dir,
	say,
	scriptedRunner,
	server,
	shellEnv,
	text,
} from '../examples/lib.js'

// MODULES=+web-search node scripts/try.js layers the shell's own +/- changes on top of this script's own.
const modules = ['+bots,+director', shellEnv.MODULES].filter(Boolean).join(',')
await server({ MODULES: modules, DIRECTOR_MODEL: 'echo/echo@bot' })
const personas = {
	ada: 'a careful reviewer',
	bram: 'a blunt engineer',
	cleo: 'a curious designer',
}
/** A bot's reply: its name and persona, how many messages it was just handed, and the newest of them */
const bots = (request) => {
	const system = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const name = /You are the bot (\w+)/.exec(system)?.[1]
	if (!name || request.messages.at(-1).role !== 'user') return undefined
	/** A person's words come as typed and everyone else's inside a <message> tag, a blank line between messages */
	const handed = text(request.messages.at(-1))
		.split(/\n\n(?=<message from=")|(?<=\n<\/message>)\n\n/)
		.filter(Boolean)
	const newest = (handed.at(-1) ?? '').replace(/\n/g, ' ').slice(0, 120)
	return say(`${name} (${personas[name]}) got ${handed.length}, newest "${newest}"`)
}
/** The director's pick: the bot whose persona's last word the message uses, else nobody */
const director = (request) => {
	const ask = text(request.messages.at(-1))
	const message = ask.match(/New message: \[[^\]]+\] (.*)/)?.[1]?.toLowerCase() ?? ''
	const name = Object.keys(personas).find((name) =>
		message.includes(personas[name].split(' ').pop().slice(0, 6)),
	)
	return say(
		name ? `${name}: it's about ${personas[name].split(' ').pop()}s` : 'nobody: nothing for them',
	)
}
const step = (request) => {
	if (text(request.messages[0] ?? { content: '' }).startsWith('You choose who answers'))
		return director(request)
	const bot = bots(request)
	if (bot) return bot
	const last = request.messages.findLastIndex((m) => m.role === 'user')
	const asked = text(request.messages[last])
	const n = request.messages.slice(last).filter((m) => m.role === 'toolResult').length
	if (n === 0)
		return fauxAssistantMessage(
			[
				fauxThinking(
					`They said "${asked.slice(0, 80)}".\nI'll start a notes file, then look around.`,
				),
				fauxToolCall('write', {
					path: 'notes.md',
					content: `# Notes\n\nasked: ${asked.slice(0, 80)}\n`,
				}),
			],
			{ stopReason: 'toolUse' },
		)
	if (n === 1) return call('read', { path: 'notes.md' })
	if (n === 2)
		return call('edit', {
			path: 'notes.md',
			edits: [{ oldText: '# Notes', newText: '# Notes, edited' }],
		})
	if (n === 3)
		return call('bash', {
			command: `${asked.includes('slow') ? 'sleep 5; ' : ''}ls -la; cat notes.md`,
		})
	if (n === 4 && asked.includes('post') && !/<message from="[^"]*" agent thread=/.test(asked))
		return call('post', {
			title: 'side question',
			body: `${asked.includes('slow') ? 'slow: ' : ''}what did you find?`,
			// "post ada" asks the bot ada instead
			to: Object.keys(personas).find((name) => asked.includes(name)) ?? 'echo/echo@bot',
		})
	return say(
		`Done. I wrote, read and edited \`notes.md\`, then ran a command:\n\n\`\`\`\n${text(request.messages.at(-1)).slice(0, 400)}\n\`\`\`\n\n- one\n- two`,
	)
}
await scriptedRunner('bot', step)

for (const name of Object.keys(personas))
	await api('POST', '/api/bots', {
		name,
		to: 'echo/echo@bot',
		instructions: `You are ${personas[name]}.`,
	})
const { json: thread } = await api('POST', '/api/threads', { title: 'try me' })
await api('POST', `/api/threads/${thread.id}/entries`, {
	body: 'look around',
	to: { runner: 'bot', model: 'echo/echo' },
})

console.log(`agent-ide at ${base}/?thread=${thread.id}
the bot works in ${dir}; send to echo/echo@bot, "post" or "slow" in a message for more
bots: ${Object.keys(personas).join(', ')}; from a terminal: export AGENT_IDE_SERVER=${base}; node cli.js post --to ada hi
stop: kill ${process.pid}`)
