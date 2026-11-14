/** A thread answers the thread that started it on its own; a post from anywhere else wakes its agent, whose answer stays home */
import {
	answers,
	api,
	brief,
	call,
	check,
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

const bot = await scriptedRunner('bot', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say('')
	if (t.includes(' answering>')) return say('heard the answer')
	if (t.includes('progress note')) return say('for oskar: go')
	if (t.includes('delegate'))
		return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo/echo@bot' })
	if (t.includes('compute 2+2')) return say('4')
	if (t.includes('report to'))
		return call('post', { thread: Number(t.match(/report to (\d+)/)[1]), body: 'progress note' })
	return say(`heard: ${t}`)
})
const to = { runner: 'bot', model: 'echo/echo' }

const {
	json: { id: parent },
} = await api('POST', '/api/threads', { title: 'parent' })
await api('POST', `/api/threads/${parent}/entries`, { body: 'please delegate this', to })
const child = await until(
	async () => (await api('GET', '/api/threads')).json.find((t) => t.parent === parent),
	10000,
)
await until(
	async () => (await view(parent)).entries.some((e) => e.data.from === child?.id && e.data.re),
	10000,
)
await quiet()

/** The parent asked, so the child's answer goes back */
const asked = (await view(child.id)).entries.find((e) => e.data.from === parent)
const back = (await view(parent)).entries.filter((e) => e.data.from === child.id)
check(
	back.length === 1 && back[0].data.body === '4' && back[0].data.re?.join() === String(asked?.id),
	"the parent's question to its child is answered there",
	brief(await view(parent)),
)

/** The child posts a note to its parent: the parent's agent wakes, and its answer stays in the parent */
await api('POST', `/api/threads/${child.id}/entries`, { body: `report to ${parent}`, to })
const woke = await until(async () => {
	const v = await view(parent)
	return answers(v).some((e) => e.data.body === 'for oskar: go') && v.status !== 'working'
		? v
		: null
}, 10000)
await quiet()
check(Boolean(woke), "the child's note wakes the parent's agent", brief(await view(parent)))
const kid = await view(child.id)
check(
	!kid.entries.some((e) => e.data.from === parent && e.data.body === 'for oskar: go'),
	"the parent's answer doesn't go back to the child",
	brief(kid),
)
const note = (await view(parent)).entries.find((e) => e.data.body === 'progress note')
const answer = answers(await view(parent)).find((e) => e.data.body === 'for oskar: go')
check(
	note && !answer?.data.re?.includes(note.id),
	'and it answers nothing there, so it shows as a plain answer',
	JSON.stringify(answer?.data),
)

bot.close()
done()
