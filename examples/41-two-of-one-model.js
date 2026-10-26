// An agent's name in a thread is model@runner unless you give it another, so two of one model work side by side.
// A recipe reaches the agent of its name, or makes one; the name reaches it in its thread, thread/name from anywhere.
// A fork keeps the names, so what a message asked still means the same agent there, with nothing remapped.
import {
	answered,
	answers,
	api,
	brief,
	call,
	check,
	conversationOf,
	done,
	runner,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()
await runner('laptop')
const echo = { runner: 'laptop', model: 'echo/echo' }
const id = (await api('POST', '/api/threads', { title: 'names' })).json.id
const post = (body, to, who) => api('POST', `/api/threads/${id}/entries`, { body, to }, who)

await post('hello', echo)
await answered(id)
await post('look again', { ...echo, name: 'reviewer' })
let v = await answered(id, 2)
check(
	v.agents.map((a) => a.name).join() === 'echo/echo@laptop,reviewer' &&
		v.agents[0].conversation !== v.agents[1].conversation,
	'name=model@runner makes a second agent with the same model, in a conversation of its own',
	JSON.stringify(v.agents),
)
check(
	answers(v).map((e) => e.data.author).join() === 'echo/echo@laptop,reviewer',
	'each answers under its own name',
	brief(v),
)

await post('and you?', echo)
v = await answered(id, 3)
check(
	v.agents.length === 2 && answers(v).at(-1).data.author === 'echo/echo@laptop',
	'the recipe again reaches the agent of its name',
	brief(v),
)
await post('you again', 'reviewer', 'ana')
await post('by address', `${id}/reviewer`)
v = await answered(id, 5)
check(
	answers(v)
		.slice(-2)
		.every((e) => e.data.author === 'reviewer') && v.agents.length === 2,
	'its name reaches the agent, and so does thread/name',
	brief(v),
)
const elsewhere = await post('wrong thread', `${id + 1000}/reviewer`)
const bad = await post('bad', { ...echo, name: 'two words' })
check(
	elsewhere.status === 400 && bad.status === 400,
	'thread/name of another thread is refused here, and so is a name with a space',
	JSON.stringify([elsewhere.json, bad.json]),
)
await api('POST', `/api/threads/${id}/read`, {}, 'ben')
check(
	(await view(id)).people.join() === 'oskar,ana,ben',
	"who's in a thread needs no state: its agents, and the people who wrote or read there",
	JSON.stringify((await view(id)).people),
)

// An agent elsewhere asks the reviewer by its address; the reviewer answers and the answer comes back.
await scriptedRunner('desk', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	return last.role === 'user' && text(last).includes('ask the reviewer')
		? call('post', { to: `${id}/reviewer`, body: 'from the desk' })
		: say('')
})
const desk = (await api('POST', '/api/threads', { title: 'desk' })).json.id
await api('POST', `/api/threads/${desk}/entries`, {
	body: 'ask the reviewer',
	to: { runner: 'desk', model: 'echo/echo' },
})
v = await answered(id, 6)
const asked = v.entries.find((e) => e.data.from === desk)
check(
	asked?.data.to?.join() === 'reviewer' && answers(v).at(-1).data.author === 'reviewer',
	"an agent's post to thread/name reaches that agent",
	brief(v),
)
await until(async () => (await view(desk)).entries.some((e) => e.data.from === id))

// A recipe makes an agent once: the same name with another recipe reaches that agent as it was made.
const moving = await post('over to the desk', { runner: 'desk', model: 'echo/echo', name: 'reviewer' })
v = await answered(id, 7)
check(
	moving.status === 201 &&
		v.agents.length === 2 &&
		v.agents.find((a) => a.name === 'reviewer').to.runner === 'laptop' &&
		answers(v).at(-1).data.author === 'reviewer',
	'the same name with another recipe reaches the agent as it was made',
	JSON.stringify(moving.json),
)

// Fork after the reviewer's answer: the same agents, and a message with no `to` asks the reviewer there too.
const reviewer = v.agents.find((a) => a.name === 'reviewer')
const f = (await api('POST', `/api/threads/${id}/fork`, { at: answers(v).at(-1).id })).json.id
await api('POST', `/api/threads/${f}/entries`, { body: 'in the fork' })
const fv = await answered(f, answers(v).length + 1)
const forked = await conversationOf(fv, 'reviewer')
check(
	fv.agents.map((a) => a.name).join() === 'echo/echo@laptop,reviewer' &&
		answers(fv).at(-1).data.author === 'reviewer' &&
		forked.conversation?.parent?.conversationId === reviewer.conversation,
	'a fork keeps the names: the last asked is still the reviewer, forked from its conversation',
	brief(fv),
)
done()
