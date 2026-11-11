/** MODULES=+bots: a bot is one name in many threads */
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
/** Pi carries the system prompt in system messages: what each runner was last asked with */
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
	'one call makes ada and her home, hands off; asked there, she joins as her model and knows she is new',
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
	'ada=model@runner gives one thread another model; a new model counts in the threads she joins next',
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
		/say what it runs as/.test(nameless.json.error),
	"a bot makes a bot with its own home, on her model; a runner's name is no bot's, and a new bot needs a model",
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

// In her home, the composer asks her with her settings: a new runner there moves her, in place, and she is told
const atHome = (await api('GET', `/api/threads/${home}`)).json.agents[0]
await post(home, 'where are you now?', { runner: 'desk', model: 'echo/echo', name: 'ada' })
v = await answered(home, 6)
const own = (await api('GET', `/api/conversations/${atHome.conversation}`)).json.entries
const told = text(own.filter((e) => e.kind === 'agent-ide.delivery').at(-1)?.model[0])
check(
	atHome.to.runner === 'laptop' &&
		v.agents.length === 1 &&
		v.agents[0].conversation === atHome.conversation &&
		v.agents[0].to.runner === 'desk' &&
		answers(v).at(-1).data.author === 'ada' &&
		told.startsWith('[You now run as echo/echo on desk,'),
	'asked as another model, a bot switches in place like any agent, keeps her name and is told',
	JSON.stringify([atHome, v.agents, told]),
)

const hide = await api('POST', `/api/threads/${home}/archive`, { archived: true })
check(
	hide.status === 400 &&
		/ada's home/.test(hide.json.error) &&
		(await api('GET', '/api/threads')).json.some((t) => t.id === home && !t.archived),
	"ada's home can't be archived while she's a bot",
	JSON.stringify(hide.json),
)

const gone = await api('DELETE', '/api/bots/ada')
await post(shed, 'still there?', 'ada')
v = await answered(shed, 3)
check(
	gone.status === 200 &&
		!(await bots()).some((b) => b.name === 'ada') &&
		(await api('GET', '/api/threads')).json.some((t) => t.id === home && !t.archived) &&
		answers(v)[2]?.data.author === 'ada' &&
		JSON.parse(prompt.laptop).at(-1).sections?.bot === null,
	'forgetting ada keeps every thread: her agents stay, without her instructions',
	JSON.stringify([gone.json, answers(v)[2]?.data, prompt.laptop]),
)

// A thread's own agent works beside its bots, and reads them as agents
await post(shed, 'what did ada say?', 'echo/echo@desk')
v = await answered(shed, 4)
const plain = v.agents.find((a) => !a.to.name)
const handed = (await api('GET', `/api/conversations/${plain?.conversation}`)).json.entries
	?.filter((e) => e.kind === 'agent-ide.delivery')
	.map((e) => text(e.model[0]))
check(
	v.agents.map((a) => a.name).join() === 'ada,echo@desk' &&
		answers(v).at(-1).data.author === 'echo@desk' &&
		handed?.[0].includes('\n\nada (agent): laptop: build it?'),
	"a thread holds one agent and any bots; the agent reads a bot's words marked as an agent's",
	JSON.stringify([v.agents, handed]),
)
const nameless2 = await post(shed, 'hi', 'rex=echo/echo@desk')
check(
	nameless2.status === 400 && /only bots have names/.test(nameless2.json.error),
	'a name that is no bot is refused',
	JSON.stringify(nameless2.json),
)
const archived = await api('POST', `/api/threads/${home}/archive`, { archived: true })
check(
	archived.status === 201,
	'forgotten, her home archives like any thread',
	JSON.stringify(archived.json),
)
done()
