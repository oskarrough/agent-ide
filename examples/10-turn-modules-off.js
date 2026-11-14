/** Modules turn off whole, picked the way Pi picks tools */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import {
	api,
	call,
	check,
	conversationOf,
	db,
	done,
	kill,
	quiet,
	runner,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

/** Pi carries the tools and the system prompt in system messages */
let offered = []
let prompt = ''
const route = (request) => {
	offered = getCurrentTools(request.messages).map((t) => t.name)
	prompt = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(`tool said: ${text(last)}`)
	if (text(last).includes('delegate'))
		return call('post', { title: 'sum', body: 'compute 2+2', to: 'echo/echo@bot' })
	return say(`heard: ${text(last)}`)
}

const fresh = () => {
	for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
}

async function round(env) {
	fresh()
	const srv = await server(env)
	const told = []
	const bot = await scriptedRunner('bot', route, { onTell: (message) => told.push(message) })
	const { modules } = (await api('GET', '/api/server')).json
	const {
		json: { id },
	} = await api('POST', '/api/threads', { title: 'parent' })
	await api('POST', `/api/threads/${id}/entries`, {
		body: 'please delegate this',
		to: { runner: 'bot', model: 'echo/echo' },
	})
	const result = await until(async () =>
		(await conversationOf(await view(id), 'echo/echo@bot')).entries.find(
			(e) => e.kind === 'pi.tool-result',
		),
	)
	await quiet()
	const children = (await api('GET', '/api/threads')).json.filter((t) => t.parent === id)
	const parent = await view(id)
	bot.close()
	await kill(srv)
	return {
		modules,
		told,
		offered,
		prompt,
		result: result && text(result.model[0]),
		children,
		parent,
	}
}

fresh()
const plain = await server()
const { modules: byDefault, off: offByDefault } = (await api('GET', '/api/server')).json
await kill(plain)
check(
	byDefault.join() === 'auto-title,bots,context,director,memory,status,talk' &&
		offByDefault.join() === 'matrix,pi-sessions,web-search',
	'each module says in its own file whether it starts on: all but matrix, pi-sessions and web-search do',
	JSON.stringify({ byDefault, offByDefault }),
)

// Auto-title asks the model too, and would overwrite what the round saw it offered
const on = await round({ MODULES: '-bots,-director,-auto-title' })
check(
	on.modules.join() === 'context,memory,status,talk',
	'talk, status, memory and context are on; this round turns bots, director and auto-title off',
	JSON.stringify(on.modules),
)
check(
	on.offered.includes('post') && on.offered.includes('threads') && on.offered.includes('read'),
	"talk on: the model has post and threads, beside Pi's own read",
	JSON.stringify(on.offered),
)
check(
	on.prompt.includes('Answers to your posts wake you'),
	'talk on: its instructions are in the prompt',
)
check(on.children.length === 1, 'talk on: the post starts a child')
check(
	on.parent.entries.some((e) => e.data.from && e.data.re),
	'talk on: the answer comes back',
)
check(
	on.told.some((m) => m.op === 'status'),
	'status on: the runner is told how its threads stand',
)

const off = await round({ MODULES: '-talk,-status,-context,-bots,-director,-memory,-auto-title' })
check(
	off.modules.length === 0,
	'every default turned off with MODULES: no modules',
	JSON.stringify(off.modules),
)
check(
	!off.offered.includes('post') && !off.offered.includes('threads') && off.offered.includes('bash'),
	'talk off: no post or threads, still the coding tools',
	JSON.stringify(off.offered),
)
check(
	!off.prompt.includes('Answers to your posts wake you'),
	'talk off: nothing about other threads in the prompt',
)
check(
	Boolean(off.result) && !/Posted to thread/.test(off.result),
	'talk off: a post call fails',
	off.result,
)
check(off.children.length === 0, 'talk off: no child thread')
check(off.told.length === 0, 'status off: no status pushes', JSON.stringify(off.told))

fresh()
const srv = await server()
for (const status of ['1', '0']) {
	let out = ''
	const env = status === '1' ? { STATUS: '1' } : { STATUS: '1', MODULES: '-status' }
	const r = await runner(`laptop${status}`, { env, wait: false })
	r.stdout.on('data', (d) => {
		out += d
	})
	await until(() =>
		api('GET', '/api/runners').then((x) =>
			x.json.some((y) => y.name === `laptop${status}` && y.online),
		),
	)
	if (status === '1') await until(async () => out.includes('\x1b]7501;'))
	r.kill()
	check(
		out.includes('\x1b]7501;') === (status === '1'),
		`runner ${JSON.stringify(env)}: ${status === '1' ? 'reports' : 'no'} OSC 7501`,
		JSON.stringify(out.slice(-200)),
	)
}
await kill(srv)

fresh()
const own = mkdtempSync(path.join(os.tmpdir(), 'agent-ide-own-'))
writeFileSync(
	path.join(own, 'agent-ide.json'),
	JSON.stringify({ modules: ['talk', 'web-search', './mine.js'] }),
)
writeFileSync(
	path.join(own, 'mine.js'),
	'export const server = ({ thread }) => ({ serve: async (id) => ({ title: (await thread(id)).title }) })',
)
const configured = await server({ MODULES: '+status' }, { cwd: own })
const listed = (await api('GET', '/api/server')).json.modules
check(
	listed.join() === 'talk,web-search,mine,status',
	'agent-ide.json picks talk, web-search and mine; MODULES=+status adds status',
	JSON.stringify(listed),
)
const made = (await api('POST', '/api/threads', { title: 'mine' })).json.id
const served = (await api('GET', `/api/threads/${made}/mine`)).json
check(
	served.title === 'mine',
	'a module of your own, by path, serves its route',
	JSON.stringify(served),
)
configured.kill()
rmSync(own, { recursive: true, force: true })
done()
