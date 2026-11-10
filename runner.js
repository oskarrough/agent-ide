import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { clampThinkingLevel } from '@earendil-works/pi-ai/models'
import {
	createAgentSessionServices,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { load } from './modules.js'
import { runnerBundle, serveRunner } from './remote.js'

// Prefer the installed pi's default; an internal path change must not stop the runner.
const { DEFAULT_THINKING_LEVEL } = await import(
	new URL('./core/defaults.js', import.meta.resolve('@earendil-works/pi-coding-agent'))
).catch(() => ({ DEFAULT_THINKING_LEVEL: 'medium' }))

const { values: args } = parseArgs({
	options: {
		server: { type: 'string', default: process.env.AGENT_IDE_SERVER || 'http://localhost:3000' },
		name: { type: 'string', default: os.hostname() },
		dir: { type: 'string', multiple: true, default: [process.cwd()] },
		'discover-dirs': { type: 'boolean', default: false },
		owner: { type: 'string', default: '' },
		'read-only': { type: 'boolean', default: false },
		allow: { type: 'string', multiple: true, default: [] },
		key: { type: 'string', default: process.env.AGENT_IDE_KEY },
		'key-file': { type: 'string' },
		help: { type: 'boolean', short: 'h' },
	},
})
if (args.help) {
	console.log(`node runner.js [options]

  --server url      server to dial (AGENT_IDE_SERVER or http://localhost:3000)
  --name name       runner's name (this machine's hostname)
  --dir folder      folder agents work in (current folder); repeat for more
  --discover-dirs   offer git and jj checkouts beneath the folders
  --owner name      take work only from this person and those allowed
  --allow name      also take work from this person or @runner; repeat for more
  --read-only       refuse writes and commands
  --key key         runner key (AGENT_IDE_KEY or the saved key)
  --key-file file   read the saved key here instead of ~/.config/agent-ide/key
  -h, --help        print these options`)
	process.exit(0)
}
/** The key connect-runner saved, for starts without it */
function saved(file) {
	const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	try {
		return readFileSync(file || path.join(config, 'agent-ide', 'key'), 'utf8').trim()
	} catch {
		return ''
	}
}
args.key ||= saved(args['key-file'])
const roots = [...new Set(args.dir.map((dir) => path.resolve(dir)))]
const dir = roots[0]
const server = new URL(args.server).origin
const name = args.name

/** pi's own models and logins, as pi reads them, with the providers its extensions add, such as claude-code */
const { modelRuntime: models, diagnostics } = await createAgentSessionServices({ cwd: dir })
for (const diagnostic of diagnostics)
	if (diagnostic.type === 'error') console.log(`pi: ${diagnostic.message}`)
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] })
models.registerNativeProvider(echo.provider)

/** What `pi --model pattern` runs */
function resolve(pattern) {
	const settings = SettingsManager.create(dir)
	const asked = pattern
		? { cliModel: pattern }
		: { cliProvider: settings.getDefaultProvider(), cliModel: settings.getDefaultModel() }
	const found = resolveCliModel({ ...asked, modelRuntime: models })
	if (!found.model) throw new Error(found.error ?? `${name} has no default model in pi; name one`)
	return {
		model: found.model,
		...(found.thinkingLevel ? { thinkingLevel: found.thinkingLevel } : {}),
		defaultThinkingLevel: clampThinkingLevel(
			found.model,
			settings.getModelThinkingLevel(found.model.provider, found.model.id) ??
				settings.getDefaultThinkingLevel() ??
				DEFAULT_THINKING_LEVEL,
		),
	}
}
const defaultModel = () => {
	try {
		const { model, thinkingLevel, defaultThinkingLevel } = resolve('')
		return {
			model: `${model.provider}/${model.id}`,
			thinkingLevel: thinkingLevel ?? defaultThinkingLevel,
		}
	} catch (error) {
		return { error: error.message }
	}
}

/** The models pi has enabled here, as `pi --models` expands them */
async function offers() {
	const patterns = SettingsManager.create(dir).getEnabledModels() ?? []
	const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, models)
	return [...new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`))]
}

/** Sent to the server, which asks a runner its updater started to update when the server's differs */
const { version } = await runnerBundle(import.meta.dirname).catch(() => ({ version: '' }))
const launched = process.env.AGENT_IDE_LAUNCHER === '1'

const modules = await load('runner', { name, server, dir, roots })

function folders() {
	const found = []
	const list = (at) => {
		try {
			return readdirSync(at, { withFileTypes: true })
		} catch {
			return []
		}
	}
	const scan = (at, depth) => {
		for (const item of list(at)) {
			if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue
			const sub = path.join(at, item.name)
			if (list(sub).some((entry) => entry.name === '.git' || entry.name === '.jj')) found.push(sub)
			else if (depth > 1) scan(sub, depth - 1)
		}
	}
	if (args['discover-dirs']) for (const root of roots) scan(root, 2)
	return [...new Set([...roots, ...found.sort()])].slice(0, 500)
}

let warnedOffers = false

async function connect() {
	const { model, thinkingLevel, error } = defaultModel()
	const query = new URLSearchParams({
		runner: name,
		owner: args.owner,
		host: os.hostname(),
		dir,
		model: model ?? '',
		thinkingLevel: thinkingLevel ?? '',
		modelError: error ?? '',
		version,
		...(args['read-only'] ? { readOnly: '1' } : {}),
	})
	if (error) console.log(`pi's default model doesn't resolve: ${error}`)
	const offered = await offers().catch((error) => {
		if (!warnedOffers) console.error(`${name}: couldn't list models: ${error.message}`)
		warnedOffers = true
		return []
	})
	for (const ref of offered) query.append('offer', ref)
	for (const who of args.allow) query.append('allow', who)
	for (const folder of folders()) query.append('folder', folder)
	const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`, {
		headers: { authorization: `Bearer ${args.key}` },
	})
	const runner = serveRunner({
		name,
		dir,
		roots,
		readable: () => modules.flatMap((module) => module.readable?.() ?? []),
		models,
		resolve,
		echo,
		ops: Object.fromEntries(
			modules.filter((module) => module.call).map((module) => [module.name, module.call]),
		),
		readOnly: args['read-only'],
		send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
		onTell: (message) =>
			message.op === 'update'
				? update()
				: modules.find((module) => module.name === message.op)?.told?.(message),
	})
	const from = args.owner ? `, to ${[args.owner, ...args.allow].join(', ')}` : ''
	const online = () =>
		// The server's own runner: the server already printed its row
		process.env.AGENT_IDE_LENT ||
		console.log(
			`${name} online at ${server}, offering pi's logins and ${roots.join(', ')}${args['read-only'] ? ' to read only' : ''}${from}`,
		)
	socket.onmessage = ({ data }) =>
		JSON.parse(data).op === 'ready' ? online() : runner.receive(data)
	socket.onclose = ({ code, reason }) => {
		runner.stopAll()
		for (const module of modules) module.disconnected?.()
		if (code === 4001) {
			console.log(reason)
			process.exit(1)
		}
		console.log(`disconnected from ${server}; retrying…`)
		setTimeout(connect, 2000)
	}
	socket.onerror = () => {}
}

let warned = false
function update() {
	if (launched) {
		console.log(`${name}: the server runs a newer runner; updating…`)
		process.exit(75)
	}
	if (!warned) console.log(`${name}: the server runs a newer runner; restart this one to update`)
	warned = true
}

connect()
