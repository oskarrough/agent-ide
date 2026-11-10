/** The API from a terminal */
import { agentTo } from './util.js'
import { defaultTitle } from './apps/client/title.js'
import { parseArgs } from 'node:util'
import { on, once } from 'node:events'
import WebSocket from 'ws'

const usage = `node cli.js [--server url] [--as name] <command>

  post <message>   post to a new thread, or --thread N, and print the answers as they land
                   --to agent    model@runner, a runner, a bot's name, or nobody; repeat for bots
                                 (left out: whom the thread last asked)
                   --thinking t  how hard they think: off, minimal, low, medium, high, xhigh, max
                   --dir d       a folder inside the runner's
                                 --thinking and --dir require a model@runner, not a bot's name
                   --title t     the new thread's title (the message's start by default)
                   --steer       join the answer being written
                   --no-wait     post and return
                   A message starting with "$ " runs a command on the runner.
  threads          every thread, with its status and agents
  read <thread>    a thread's messages, or its --last N, or those --after id
  wait <thread>    wait until its agents are done, then print the answers to the latest ask, or all --after id
  runners          every runner holding a key, online or not, and its models
  key <runner>     a new key for a runner, replacing its old one, and the line that connects it
  revoke <runner>  take its key away: it goes offline and leaves the list
  stop <thread>    stop its agents and commands`

const parse = (options) => {
	try {
		return parseArgs({ allowPositionals: true, options })
	} catch (error) {
		console.error(`${error.message}\n\n${usage}`)
		process.exit(1)
	}
}
/** A person's own name, unless an agent's bash tool set PI_SESSION_ID: then it writes as its model, not whoever owns the shell */
const defaultAs = () =>
	(process.env.PI_SESSION_ID &&
		`${process.env.PI_MODEL ?? 'agent'}${process.env.PI_REASONING_LEVEL ? `:${process.env.PI_REASONING_LEVEL}` : ''}`) ||
	process.env.USER ||
	'anon'

const {
	values: flags,
	positionals: [command, ...rest],
} = parse({
	server: { type: 'string', default: process.env.AGENT_IDE_SERVER || 'http://127.0.0.1:3000' },
	as: { type: 'string', default: defaultAs() },
	thread: { type: 'string' },
	to: { type: 'string', multiple: true },
	thinking: { type: 'string' },
	dir: { type: 'string' },
	title: { type: 'string' },
	steer: { type: 'boolean' },
	'no-wait': { type: 'boolean' },
	last: { type: 'string' },
	after: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
})

async function api(method, route, body) {
	const res = await fetch(flags.server + route, {
		method,
		headers: { 'content-type': 'application/json', 'x-user': flags.as },
		body: body && JSON.stringify(body),
	})
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? res.statusText)
	return json
}

function agent(name) {
	if (!flags.thinking && !flags.dir) return name
	if (!name.includes('@'))
		throw new Error('--thinking and --dir require a model@runner, not a bot name')
	return {
		...agentTo(name),
		...(flags.thinking ? { thinkingLevel: flags.thinking } : {}),
		...(flags.dir ? { dir: flags.dir } : {}),
	}
}

function show({ id, data: message }) {
	const shell =
		message.shell &&
		[
			message.shell.stdout,
			message.shell.stderr,
			message.shell.error,
			message.shell.code ? `exit ${message.shell.code}` : '',
		]
			.filter(Boolean)
			.join('\n')
	console.log(
		`#${id} ${message.author}${message.to ? ` → ${message.to.join(', ')}` : ''}${message.from ? ` (from thread ${message.from})` : ''}\n${message.body}${shell ? `\n${shell}` : ''}\n`,
	)
}

async function post() {
	const body = rest.join(' ')
	if (!body) throw new Error('post what?')
	const fresh = !flags.thread
	const id = fresh
		? (await api('POST', '/api/threads', { title: flags.title ?? defaultTitle(body) })).id
		: Number(flags.thread)
	const seen = (await api('GET', `/api/threads/${id}`)).entries.at(-1)?.id ?? 0
	const to = flags.to && (flags.to.includes('nobody') ? null : flags.to.map(agent))
	/** Listen before posting so even an immediate answer can't slip between the read and the wait */
	const socket = flags['no-wait']
		? null
		: new WebSocket(flags.server.replace(/^http/, 'ws') + '/ws')
	const changes = socket && on(socket, 'message', { close: ['close'] })
	try {
		if (socket) await once(socket, 'open')
		const posted = await api('POST', `/api/threads/${id}/entries`, {
			body,
			...(flags.to ? { to } : {}),
			...(flags.steer ? { steer: true } : {}),
			requestId: crypto.randomUUID(),
		}).catch(async (error) => {
			// A new thread that never got its message isn't worth keeping
			if (fresh) await api('POST', `/api/threads/${id}/archive`, { archived: true }).catch(() => {})
			if (error.message.startsWith('No runner named ')) {
				const names = (await api('GET', '/api/runners')).map((runner) => runner.name)
				error.message += names.length
					? `. Runners: ${names.join(', ')}`
					: '. No runner has connected yet'
			}
			throw error
		})
		if (fresh) console.log(`thread ${id}`)
		const asked = posted.command || posted.to?.length
		if (!asked && !flags.to)
			console.error('Asked nobody: name a model@runner, a runner or a bot with --to')
		if (flags['no-wait'] || !asked) return
		let last = posted.entry ?? seen
		let waiting = ''
		for (;;) {
			const view = await api('GET', `/api/threads/${id}`)
			for (const entry of view.entries.filter((entry) => entry.id > last)) {
				if (entry.id !== posted.entry) show(entry)
				last = entry.id
			}
			const blocked = view.agents
				.filter((agent) => agent.status === 'blocked')
				.map((agent) => agent.to?.runner)
			if (blocked.join() !== waiting && (waiting = blocked.join()))
				console.error(`waiting for ${waiting}, offline…`)
			if (!['working', 'blocked'].includes(view.status)) return
			if ((await changes.next()).done)
				throw new Error('Server disconnected while waiting for the answer')
		}
	} finally {
		await changes?.return()
		socket?.close()
	}
}

const commands = {
	post,
	async threads() {
		for (const thread of await api('GET', '/api/threads'))
			console.log(
				`#${thread.id} ${thread.title}  ${thread.status}${thread.agents.length ? `  ${thread.agents.map((agent) => agent.name).join(', ')}` : ''}${thread.parent ? `  child of #${thread.parent}` : ''}`,
			)
	},
	async read() {
		const { entries } = await api('GET', `/api/threads/${Number(rest[0])}`)
		for (const entry of entries
			.filter((entry) => entry.id > Number(flags.after ?? 0))
			.slice(-(Number(flags.last) || entries.length)))
			show(entry)
	},
	async wait() {
		const id = Number(rest[0])
		const socket = new WebSocket(flags.server.replace(/^http/, 'ws') + '/ws')
		const changes = on(socket, 'message', { close: ['close'] })
		try {
			await once(socket, 'open')
			for (;;) {
				const view = await api('GET', `/api/threads/${id}`)
				if (!['working', 'blocked'].includes(view.status)) {
					const asked = view.entries.findLast((entry) => entry.data.to?.length)?.id ?? 0
					const after = flags.after ? Number(flags.after) : asked
					return view.entries.filter((entry) => entry.id > after).forEach(show)
				}
				if ((await changes.next()).done) throw new Error('Server disconnected while waiting')
			}
		} finally {
			await changes.return()
			socket.close()
		}
	},
	async runners() {
		for (const runner of await api('GET', '/api/runners')) {
			console.log(
				!runner.dir
					? `${runner.name} waiting for it to dial in`
					: `${runner.name} ${runner.online ? 'online' : 'offline'}${runner.busy ? `, busy in ${runner.busy}` : ''}  ${runner.dir}${runner.readOnly ? ' (read-only)' : ''}  default ${runner.model || `none${runner.modelError ? `: ${runner.modelError}` : ''}`}`,
			)
			for (const folder of (runner.folders ?? []).slice(1)) console.log(`  folder ${folder}`)
			for (const model of runner.offers) console.log(`  ${model}@${runner.name}`)
		}
	},
	async key() {
		const { key, connect } = await api('POST', '/api/runners', { name: rest[0] })
		console.log(
			`AGENT_IDE_KEY=${key}\n\nOn the runner's machine:\n  ${connect}\nor from a clone:\n  AGENT_IDE_KEY=${key} node runner.js --server ${flags.server} --name ${rest[0]} --dir .`,
		)
	},
	async revoke() {
		await api('DELETE', `/api/runners/${encodeURIComponent(rest[0] ?? '')}`)
		console.log(`${rest[0]} revoked`)
	},
	stop: () => api('POST', `/api/threads/${Number(rest[0])}/stop`),
}

if (flags.help || !commands[command]) {
	console.log(usage)
	process.exit(flags.help ? 0 : 1)
}
await commands[command]().catch((error) => {
	console.error(error.message)
	process.exit(1)
})
