/** A steer joins the answer being written, and another thread's post steers like a person's Enter; a stop withdraws the follow-ups queued behind it, and the next input carries them */
import {
	answered,
	answers,
	api,
	brief,
	call,
	check,
	conversationOf,
	done,
	quiet,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()
const bot = await scriptedRunner('bot', (request) =>
	request.messages.some((m) => m.role === 'toolResult')
		? say('answered both')
		: call('bash', { command: 'sleep 0.5' }),
)
const to = { runner: 'bot', model: 'echo/echo' }
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'steer' })
const first = (await api('POST', `/api/threads/${id}/entries`, { body: 'first', to, steer: true }))
	.json.entry
check(
	Boolean(
		await until(
			async () =>
				(await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.what === 'exec')),
			8000,
			10,
		),
	),
	'the first input is inside its tool call',
)
const second = (
	await api('POST', `/api/threads/${id}/entries`, { body: 'second', to, steer: true })
).json.entry
const v = (await answered(id)) ?? (await view(id))
const inputs = (await conversationOf(v, 'echo/echo@bot')).entries
	.filter((e) => e.kind === 'agent-ide.delivery')
	.map((e) => text(e.model[0]))
check(inputs.includes('second'), 'Pi placed the steer', JSON.stringify(inputs))
check(answers(v).length === 1, 'both inputs share one answer')
check(
	JSON.stringify(answers(v)[0]?.data.re) === JSON.stringify([first, second]),
	'the answer says it answers both',
	JSON.stringify(answers(v)[0]?.data.re),
)
const idle = (
	await api('POST', `/api/threads/${id}/entries`, { body: 'idle again', to, steer: true })
).json.entry
const restarted = await answered(id, 2)
check(
	restarted &&
		answers(restarted).length === 2 &&
		JSON.stringify(answers(restarted)[1]?.data.re) === JSON.stringify([idle]),
	'a steer sent while idle starts its own run',
	JSON.stringify(restarted?.entries.map((entry) => entry.data)),
)
bot.close()

/** Another thread's agent posts mid-run: its message joins the answer being written, as a person's Enter does */
const dee = await scriptedRunner('dee', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say(t.startsWith('Posted') ? '' : 'dee answered both')
	if (t.includes('tell thread'))
		return call('post', { thread: Number(t.match(/thread (\d+)/)[1]), body: 'news' })
	if (t.includes('work')) return call('bash', { command: 'sleep 0.5' })
	return say('dee heard')
})
const toDee = { runner: 'dee', model: 'echo/echo' }
const {
	json: { id: busy },
} = await api('POST', '/api/threads', { title: 'busy' })
const {
	json: { id: teller },
} = await api('POST', '/api/threads', { title: 'teller' })
const work = (await api('POST', `/api/threads/${busy}/entries`, { body: 'work', to: toDee })).json
	.entry
check(
	Boolean(
		await until(
			async () =>
				(await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.what === 'exec')),
			8000,
			10,
		),
	),
	'the busy agent is inside its tool call',
)
await api('POST', `/api/threads/${teller}/entries`, { body: `tell thread ${busy}`, to: toDee })
const news = await until(
	async () => (await view(busy)).entries.find((e) => e.data.from === teller),
	8000,
	10,
)
const told = await answered(busy)
await quiet()
check(
	Boolean(news) &&
		answers(told).length === 1 &&
		JSON.stringify(answers(told)[0].data.re) === JSON.stringify([work]),
	"another thread's post joined the answer being written",
	JSON.stringify(told?.entries.map((entry) => entry.data)),
)
check(
	!(await view(teller)).entries.some((entry) => entry.data.from === busy),
	"and since busy isn't teller's child, the answer stays in busy",
	brief(await view(teller)),
)
dee.close()

const cy = await scriptedRunner('cy', (request) => {
	const t = text(request.messages.findLast((m) => m.role === 'user'))
	if (t.includes('again')) return say('cy heard it all')
	if (request.messages.at(-1).role === 'user' && t.includes('work'))
		return call('bash', { command: 'sleep 0.5' })
	return say(`cy thinks ${'hmm '.repeat(300)}`)
})
const toCy = { runner: 'cy', model: 'echo/echo' }
const {
	json: { id: gap },
} = await api('POST', '/api/threads', { title: 'gap' })
const cyInputs = async () =>
	(await conversationOf(await view(gap), 'echo/echo@cy')).entries
		?.filter((e) => e.kind === 'agent-ide.delivery')
		.map((e) => text(e.model[0])) ?? []
await api('POST', `/api/threads/${gap}/entries`, { body: 'work', to: toCy })
await until(
	async () =>
		(await conversationOf(await view(gap), 'echo/echo@cy')).entries?.some(
			(e) => e.kind === 'pi.assistant',
		),
	8000,
	20,
)
await api('POST', `/api/threads/${gap}/entries`, { body: 'and a follow-up', to: toCy })
await api('POST', `/api/threads/${gap}/entries`, { body: 'steer now', to: toCy, steer: true })
const steered = await until(
	async () => (await cyInputs()).some((t) => t.includes('steer now')),
	8000,
	20,
)
await api('POST', `/api/threads/${gap}/stop`, {})
const before = await cyInputs()
check(
	Boolean(steered) && !before.some((t) => t.includes('follow-up')),
	'the steer was placed, the follow-up withdrawn',
	JSON.stringify(before),
)
await api('POST', `/api/threads/${gap}/entries`, { body: 'again', to: toCy })
await answered(gap, 1)
const last = (await cyInputs()).at(-1)
check(
	last === 'and a follow-up\n\nagain',
	'the next input carries the withdrawn follow-up',
	JSON.stringify(last),
)

cy.close()
done()
