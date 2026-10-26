// MODULES=+bots: a bot is one name in many threads. Its home thread holds its recipe and instructions; asked by name
// anywhere else, an agent of that name joins there, made from the home recipe, and name=model@runner gives that thread
// another model. Every one of them reads the bot's instructions before each request and knows its other threads.
import { answered, answers, api, check, done, say, scriptedRunner, server, text } from './lib.js'

await server({ MODULES: '+bots' })
// Pi carries the system prompt in system messages: what each runner was last asked with.
const prompt = {}
const route = (runner) => (request) => {
	prompt[runner] = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	return say(`${runner}: ${text(request.messages.findLast((m) => m.role === 'user'))}`)
}
await scriptedRunner('laptop', route('laptop'))
await scriptedRunner('desk', route('desk'))
const thread = async (title) => (await api('POST', '/api/threads', { title })).json.id
const post = (id, body, to) => api('POST', `/api/threads/${id}/entries`, { body, to })
const bots = (id, body) => api('POST', `/api/threads/${id}/bots`, body)

const home = await thread('Ada')
const made = await bots(home, { name: 'ada', instructions: 'Answer like a pirate.' })
const shed = await thread('shed')
const early = await post(shed, 'hello', 'ada')
check(
	made.status === 201 && early.status === 400 && /ask ada=model@runner there/.test(early.json.error),
	'a thread is made a bot\'s home; asked before it has an agent there, the bot says how to make one',
	JSON.stringify([made.json, early.json]),
)

await post(home, 'ahoy', 'ada=echo/echo@laptop')
let v = await answered(home)
check(
	v.agents.map((a) => a.name).join() === 'ada' && prompt.laptop.includes('Answer like a pirate.'),
	'at home, ada=model@runner makes ada, who reads the bot\'s instructions',
	prompt.laptop,
)

await post(shed, 'build it?', 'ada')
v = await answered(shed)
const ada = v.agents.find((a) => a.name === 'ada')
check(
	ada?.to.runner === 'laptop' &&
		ada.to.model === 'echo/echo' &&
		answers(v)[0]?.data.author === 'ada' &&
		prompt.laptop.includes('Answer like a pirate.') &&
		prompt.laptop.includes(`${home} \\"Ada\\" (home)`),
	'asked by name in another thread, ada joins it from her home recipe, with her instructions and her other threads',
	JSON.stringify([ada, prompt.laptop]),
)

const desk = await thread('desk work')
await post(desk, 'and here?', 'ada=echo/echo@desk')
v = await answered(desk)
check(
	v.agents.find((a) => a.name === 'ada')?.to.runner === 'desk' &&
		prompt.desk.includes('Answer like a pirate.') &&
		prompt.desk.includes(`${shed} \\"shed\\"`),
	'ada=model@runner gives a thread another model; she is still ada',
	prompt.desk,
)

await bots(home, { name: 'ada', instructions: 'Answer like a poet.' })
await post(shed, 'and now?', 'ada')
await answered(shed, 2)
check(
	prompt.laptop.includes('Answer like a poet.'),
	'an edit at home counts from her next request, in every thread',
	prompt.laptop,
)

const moved = await bots(shed, { name: 'ada' })
const runnerName = await bots(shed, { name: 'desk' })
const listed = (await api('GET', `/api/threads/${home}/bots`)).json
check(
	moved.status === 400 &&
		runnerName.status === 400 &&
		listed.length === 1 &&
		listed[0].home === home &&
		listed[0].instructions === 'Answer like a poet.',
	'a bot has one home, a runner\'s name is no bot\'s name, and GET lists the bots',
	JSON.stringify([moved.json, runnerName.json, listed]),
)
done()
