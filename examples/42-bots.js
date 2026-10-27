// MODULES=+bots: a bot is one name in many threads. One call makes it and its home thread, hands off; asked by name
// anywhere else, an agent of that name joins there from the bot's recipe, and name=model@runner gives that thread
// another model. Every one of them reads the bot's instructions and knows its other threads. At home its `bot` tool
// rewrites it or makes another bot. Its home can't be hidden while it's a bot; forgetting a bot keeps every thread.
import {
	answered,
	answers,
	api,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
} from './lib.js'

await server({ MODULES: '+bots' })
// Pi carries the system prompt in system messages: what each runner was last asked with.
const prompt = {}
const route = (runner) => (request) => {
	prompt[runner] = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say(`tool: ${t}`)
	if (t.includes('be a pirate')) return call('bot', { instructions: 'Answer like a pirate.' })
	if (t.includes('make wren')) return call('bot', { name: 'wren', instructions: 'Review diffs.' })
	if (t.includes('ask wren'))
		return call('post', { to: 'wren', title: 'a diff', body: 'look at this' })
	return say(`${runner}: ${t}`)
}
await scriptedRunner('laptop', route('laptop'))
await scriptedRunner('desk', route('desk'))
const thread = async (title) => (await api('POST', '/api/threads', { title })).json.id
const post = (id, body, to) => api('POST', `/api/threads/${id}/entries`, { body, to })
const bots = async () => (await api('GET', '/api/bots')).json

const made = await api('POST', '/api/bots', { name: 'ada', to: 'echo/echo@laptop' })
const home = made.json.home
const homeRow = (await api('GET', '/api/threads')).json.find((t) => t.id === home)
await post(home, 'who are you?', 'ada')
let v = await answered(home)
check(
	made.status === 201 &&
		homeRow?.title === 'ada' &&
		homeRow.tools.join() === '-write,-edit,-bash' &&
		v.agents.map((a) => a.name).join() === 'ada' &&
		prompt.laptop.includes("You're new"),
	'one call makes ada and her home, hands off; asked there, she joins from her recipe and knows she is new',
	JSON.stringify([made.json, homeRow, prompt.laptop]),
)

await post(home, 'be a pirate', 'ada')
await answered(home, 2)
const shed = await thread('shed')
await post(shed, 'build it?', 'ada')
v = await answered(shed)
const ada = v.agents.find((a) => a.name === 'ada')
check(
	(await bots())[0].instructions === 'Answer like a pirate.' &&
		ada?.to.runner === 'laptop' &&
		answers(v)[0]?.data.author === 'ada' &&
		prompt.laptop.includes('Answer like a pirate.') &&
		prompt.laptop.includes(`${home} \\"ada\\" (home)`),
	'at home she writes her own instructions; asked elsewhere, she joins with them and knows her home',
	JSON.stringify([await bots(), ada, prompt.laptop]),
)

await post(shed, 'be a pirate', 'ada')
v = await answered(shed, 2)
check(
	/Only a bot can, in its home thread/.test(answers(v)[1]?.data.body),
	'away from home, her bot tool refuses',
	answers(v)[1]?.data.body,
)

const desk = await thread('desk work')
await post(desk, 'and here?', 'ada=echo/echo@desk')
v = await answered(desk)
await api('POST', '/api/bots', { name: 'ada', to: 'echo/echo@desk' })
const yard = await thread('yard')
await post(yard, 'hi', 'ada')
const y = await answered(yard)
check(
	v.agents.find((a) => a.name === 'ada')?.to.runner === 'desk' &&
		y.agents.find((a) => a.name === 'ada')?.to.runner === 'desk' &&
		(await api('GET', `/api/threads/${shed}`)).json.agents.find((a) => a.name === 'ada')?.to
			.runner === 'laptop',
	'ada=model@runner gives one thread another model; a new recipe counts in the threads she joins next',
	JSON.stringify([v.agents, y.agents]),
)

await post(home, 'make wren', 'ada')
await answered(home, 3)
const wren = (await bots()).find((b) => b.name === 'wren')
const runnerName = await api('POST', '/api/bots', { name: 'desk', to: 'echo/echo@desk' })
const nameless = await api('POST', '/api/bots', { name: 'rex' })
check(
	wren?.instructions === 'Review diffs.' &&
		wren.to.runner === 'laptop' &&
		wren.home !== home &&
		runnerName.status === 400 &&
		/give it a recipe/.test(nameless.json.error),
	"a bot makes a bot with its own home, on her model; a runner's name is no bot's, and a new bot needs a recipe",
	JSON.stringify([await bots(), runnerName.json, nameless.json]),
)

await post(home, 'ask wren', 'ada')
await answered(home, 5)
const side = (await api('GET', '/api/threads')).json.find((t) => t.parent === home)
check(
	prompt.laptop.includes('The other bot is wren') &&
		side?.agents.map((a) => a.name).join() === 'wren' &&
		answers(await (await api('GET', `/api/threads/${side.id}`)).json)[0]?.data.author === 'wren',
	'a bot knows the other bots by name, and asks one with post',
	JSON.stringify([side, prompt.laptop]),
)

const hide = await api('DELETE', `/api/threads/${home}`)
check(
	hide.status === 400 &&
		/ada's home/.test(hide.json.error) &&
		(await api('GET', '/api/threads')).json.some((t) => t.id === home && !t.hidden),
	"ada's home can't be hidden while she's a bot",
	JSON.stringify(hide.json),
)

const gone = await api('DELETE', '/api/bots/ada')
await post(shed, 'still there?', 'ada')
v = await answered(shed, 3)
check(
	gone.status === 200 &&
		!(await bots()).some((b) => b.name === 'ada') &&
		(await api('GET', '/api/threads')).json.some((t) => t.id === home && !t.hidden) &&
		answers(v)[2]?.data.author === 'ada' &&
		JSON.parse(prompt.laptop).at(-1).sections?.bot === null,
	'forgetting ada keeps every thread: her agents stay, without her instructions',
	JSON.stringify([gone.json, answers(v)[2]?.data, prompt.laptop]),
)
const hidden = await api('DELETE', `/api/threads/${home}`)
check(hidden.status === 200, 'forgotten, her home hides like any thread', JSON.stringify(hidden.json))
done()
