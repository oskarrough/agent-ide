/** A thread has one agent: ask it as another model, thinking, runner or folder and it switches in place, as in pi, keeping its conversation, and is told when it moves */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	api,
	brief,
	call,
	check,
	conversationOf,
	dir,
	done,
	localRunner,
	say,
	scriptedRunner,
	server,
	text,
	view,
} from './lib.js'

await server()
/** Two models on one runner; each request says what it was handed and how hard it thought */
const requests = []
const script = fauxProvider({
	provider: 'echo',
	models: [
		{ id: 'one', reasoning: true },
		{ id: 'two', reasoning: true },
	],
	tokensPerSecond: 200,
})
script.setResponses(
	Array.from({ length: 200 }, () => (context, options) => {
		requests.push({ context: JSON.stringify(context.messages), thinking: options?.reasoning })
		return say(`heard: ${text(context.messages.findLast((m) => m.role === 'user')).slice(-40)}`)
	}),
)
const models = createModels()
models.setProvider(script.provider)
await localRunner('laptop', {
	models,
	resolve: (pattern) => ({
		model: script.getModel(String(pattern).split('/').pop()) ?? script.getModel(),
	}),
	echo: script,
	model: 'echo/one',
})
const id = (await api('POST', '/api/threads', { title: 'switch' })).json.id
const post = (body, to, who) =>
	api('POST', `/api/threads/${id}/entries`, { body, ...(to === undefined ? {} : { to }) }, who)
const deliveries = async (v) =>
	(await conversationOf(v, v.agents[0].name)).entries
		.filter((e) => e.kind === 'agent-ide.delivery')
		.map((e) => text(e.model[0]))

await post('remember the number 7', { runner: 'laptop', model: 'echo/one' })
let v = await answered(id)
const first = v.agents[0]
await post('which number?', { runner: 'laptop', model: 'echo/two', thinkingLevel: 'high' }, 'ana')
v = await answered(id, 2)
check(
	v.agents.length === 1 &&
		v.agents[0].conversation === first.conversation &&
		v.agents[0].to.model === 'echo/two' &&
		v.agents[0].to.thinkingLevel === 'high',
	'asking with another model and thinking switches the one agent, in the same conversation',
	JSON.stringify([first, v.agents]),
)
check(
	requests.at(-1).context.includes('remember the number 7') &&
		requests.at(-1).context.includes('heard: ') &&
		requests.at(-1).thinking === 'high',
	'the new model reads the whole conversation so far, and thinks as hard as it was asked',
	JSON.stringify(requests.at(-1)),
)
check(
	answers(v)
		.map((e) => e.data.author)
		.join() === 'one@laptop,two:high@laptop' && v.entries[2].data.to.join() === 'two:high@laptop',
	'each answer names the model that wrote it',
	brief(v),
)
const told = (await deliveries(v)).at(-1)
check(
	told.startsWith('[You now run as echo/two:high on laptop, in ') &&
		!told.includes('Files and paths') &&
		told.endsWith('ana: which number?'),
	'the agent is told it switched, before what it was asked',
	told,
)

await post('and now?')
v = await answered(id, 3)
check(
	answers(v).at(-1).data.author === 'two:high@laptop' &&
		!(await deliveries(v)).at(-1).startsWith('[') &&
		requests.at(-1).thinking === 'high',
	'with no pick, the thread asks its agent as it is, and nothing new is said about it',
	brief(v),
)

await post('same model, no level', { runner: 'laptop', model: 'echo/two' })
v = await answered(id, 4)
check(
	requests.at(-1).thinking === 'high' && v.agents[0].to.thinkingLevel === 'high',
	'an agent named without a level keeps the level it has',
	JSON.stringify(v.agents[0].to),
)

const named = await post('be the reviewer', {
	runner: 'laptop',
	model: 'echo/one',
	name: 'reviewer',
})
check(
	named.status === 400 && /only bots have names/.test(named.json.error),
	'a plain agent takes no name; only bots have names',
	JSON.stringify(named.json),
)

await api('POST', `/api/threads/${id}/read`, {}, 'ben')
check(
	(await view(id)).people.join() === 'oskar,ana,ben',
	"who's in a thread needs no state: the people who wrote or read there",
	JSON.stringify((await view(id)).people),
)

const f = (await api('POST', `/api/threads/${id}/fork`, { at: answers(v).at(-1).id })).json.id
await api('POST', `/api/threads/${f}/entries`, { body: 'in the fork' })
const fv = await answered(f, answers(v).length + 1)
const forked = await conversationOf(fv, 'echo/two@laptop')
check(
	fv.agents.length === 1 &&
		answers(fv).at(-1).data.author === 'two:high@laptop' &&
		forked.conversation?.parent?.conversationId === first.conversation,
	'a fork carries the agent as it runs now, forked from its conversation',
	brief(fv),
)
// Moving runner or folder
mkdirSync(path.join(dir, 'site'))
const heard = { desk: [], vps: [] }
const route = (runner) => (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(`${runner} in ${text(last).trim()}`)
	heard[runner].push(JSON.stringify(request.messages))
	return call('bash', { command: 'pwd' })
}
await scriptedRunner('desk', route('desk'))
await scriptedRunner('vps', route('vps'))
const moving = (await api('POST', '/api/threads', { title: 'move' })).json.id
const askThere = async (body, to, n) => {
	await api('POST', `/api/threads/${moving}/entries`, { body, to })
	const v = await answered(moving, n)
	const own = await conversationOf(v, v.agents[0].name)
	return {
		v,
		answer: answers(v).at(-1)?.data.body,
		told: text(own.entries.filter((e) => e.kind === 'agent-ide.delivery').at(-1)?.model[0]),
		cwd: own.docs['pi.agent'].cwd,
	}
}

const before = await askThere('where are you?', { runner: 'desk', model: 'echo/echo' }, 1)
const conversation = before.v.agents[0].conversation
const moved = await askThere('and now?', { runner: 'vps', model: 'echo/echo', dir: 'site' }, 2)
check(
	moved.v.agents.length === 1 &&
		moved.v.agents[0].conversation === conversation &&
		moved.v.agents[0].to.runner === 'vps' &&
		moved.v.agents[0].to.dir === 'site' &&
		moved.answer === `vps in ${path.join(dir, 'site')}`,
	"asked on the vps in site, the thread's agent moves there: its tools run on the vps, in that folder",
	JSON.stringify([moved.v.agents, moved.answer]),
)
check(
	heard.vps.at(-1).includes('where are you?') && heard.vps.at(-1).includes(`desk in ${dir}`),
	'it keeps its conversation, what it did on the desk included',
	heard.vps.at(-1)?.slice(0, 200),
)
check(
	moved.told.startsWith(
		`[You now run as echo/echo on vps, in ${path.join(dir, 'site')}. Files and paths from before may not be here`,
	) && moved.told.endsWith('\n\nand now?'),
	'it is told where it is now, and not to trust paths from before',
	moved.told,
)

const stays = await askThere('again', { runner: 'vps', model: 'echo/echo' }, 3)
check(
	stays.cwd === path.join(dir, 'site') && stays.told === 'again',
	'the same runner without a folder keeps the folder, and says nothing new',
	JSON.stringify([stays.cwd, stays.told]),
)

const back = await askThere('home', 'echo/echo@desk', 4)
check(
	back.cwd === dir &&
		back.v.agents[0].to.dir === undefined &&
		back.told.startsWith(`[You now run as echo/echo on desk, in ${dir}.`) &&
		back.answer === `desk in ${dir}`,
	"another runner without a folder starts at that runner's own",
	JSON.stringify([back.cwd, back.told, brief(back.v)]),
)
done()
