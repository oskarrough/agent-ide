/** An agent that answers its asker with `post` said it in its own thread too: the thread shows it, the asker gets the short reply */
import {
	api,
	brief,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()
await scriptedRunner('bot', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say('')
	if (t.includes('delegate'))
		return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo/echo@bot' })
	if (t.includes('compute 2+2'))
		return call('post', { thread: Number(t.match(/ thread="(\d+)"/)[1]), body: 'by post: 4' })
	return say('')
})

const {
	json: { id: asker },
} = await api('POST', '/api/threads', { title: 'asker' })
await api('POST', `/api/threads/${asker}/entries`, {
	body: 'delegate',
	to: { runner: 'bot', model: 'echo/echo' },
})
const back = await until(async () => {
	const v = await view(asker)
	return v.entries.find((e) => e.data.body === 'by post: 4')
}, 15000)
const child = (await api('GET', '/api/threads')).json.find((t) => t.parent === asker).id
const said = (await view(child)).entries.filter((e) => e.data.body === 'by post: 4')
check(
	back?.data.from === child && back.data.re?.length === 1,
	'the asking thread gets the answer, marked as from the child',
	brief(await view(asker)),
)
check(
	said.length === 1 && !said[0].data.from && said[0].data.author === back?.data.author,
	'the child shows the answer its agent gave by post, once',
	brief(await view(child)),
)
await until(
	async () => (await api('GET', '/api/threads')).json.every((t) => t.status !== 'working'),
	10000,
)
const again = (await view(child)).entries.filter((e) => e.data.body === 'by post: 4')
check(
	again.length === 1,
	'its agent does not read its own answer back as news',
	brief(await view(child)),
)
done()
