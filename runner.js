import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
	createAgentSessionServices,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { load } from './modules.js'
import { runnerBundle, serveRunner } from './remote.js'

const { values: args } = parseArgs({
	options: {
		server: { type: 'string', default: process.env.AGENT_IDE_SERVER || 'http://localhost:3000' },
		name: { type: 'string', default: os.hostname() },
		alias: { type: 'string', default: '' },
		dir: { type: 'string', default: process.cwd() },
		owner: { type: 'string', default: '' },
		'read-only': { type: 'boolean', default: false },
		allow: { type: 'string', multiple: true, default: [] },
		key: { type: 'string', default: process.env.AGENT_IDE_KEY || saved() },
	},
})
// The key connect-runner saved, for starts without it.
function saved() {
	const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	try {
		return readFileSync(path.join(config, 'agent-ide', 'key'), 'utf8').trim()
	} catch {
		return ''
	}
}
const dir = path.resolve(args.dir)
const server = new URL(args.server).origin
const name = args.name

// pi's own models and logins, as pi reads them, with the providers its extensions add, such as claude-code; the
// logins never leave this machine.
const { modelRuntime: models, diagnostics } = await createAgentSessionServices({ cwd: dir })
for (const d of diagnostics) if (d.type === 'error') console.log(`pi: ${d.message}`)
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }] })
models.registerNativeProvider(echo.provider)

// What `pi --model pattern` runs; no pattern is pi's default model and thinking level, from its settings in the folder.
function resolve(pattern) {
	const settings = SettingsManager.create(dir)
	const asked = pattern
		? { cliModel: pattern }
		: { cliProvider: settings.getDefaultProvider(), cliModel: settings.getDefaultModel() }
	const found = resolveCliModel({ ...asked, modelRuntime: models })
	if (!found.model) throw new Error(found.error ?? `${name} has no default model in pi; name one`)
	return {
		model: found.model,
		thinkingLevel:
			found.thinkingLevel ?? (pattern ? undefined : settings.getDefaultThinkingLevel()),
	}
}
const defaultModel = () => {
	try {
		const { model } = resolve('')
		return { model: `${model.provider}/${model.id}` }
	} catch (error) {
		return { error: error.message }
	}
}

// The models pi has enabled here, as `pi --models` expands them.
async function offers() {
	const patterns = SettingsManager.create(dir).getEnabledModels() ?? []
	const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, models)
	return [...new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`))]
}

// Sent to the server, which asks a runner its updater started to update when the server's differs.
const { version } = await runnerBundle(import.meta.dirname).catch(() => ({ version: '' }))
const launched = process.env.AGENT_IDE_LAUNCHER === '1'

const modules = await load('runner', { status: true, context: true }, { name, server, dir })

async function connect() {
	const { model, error } = defaultModel()
	const query = new URLSearchParams({
		runner: name,
		alias: args.alias,
		owner: args.owner,
		host: os.hostname(),
		dir,
		model: model ?? '',
		modelError: error ?? '',
		version,
		...(args['read-only'] ? { readOnly: '1' } : {}),
	})
	if (error) console.log(`pi's default model doesn't resolve: ${error}`)
	for (const ref of await offers().catch(() => [])) query.append('offer', ref)
	for (const who of args.allow) query.append('allow', who)
	const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`, {
		headers: { authorization: `Bearer ${args.key}` },
	})
	const runner = serveRunner({
		name,
		dir,
		models,
		resolve,
		echo,
		ops: Object.fromEntries(modules.filter((m) => m.call).map((m) => [m.name, m.call])),
		readOnly: args['read-only'],
		send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
		onTell: (message) =>
			message.op === 'update'
				? update()
				: modules.find((m) => m.name === message.op)?.told?.(message),
	})
	const from = args.owner ? `, to ${[args.owner, ...args.allow].join(', ')}` : ''
	socket.onopen = () =>
		console.log(
			`${name} online at ${server}, lending pi's logins and ${dir}${args['read-only'] ? ' to read only' : ''}${from}`,
		)
	socket.onmessage = ({ data }) => runner.receive(data)
	socket.onclose = ({ code, reason }) => {
		runner.stopAll()
		for (const m of modules) m.disconnected?.()
		// Turned away, or revoked: dialling back would only be turned away again.
		if (code === 4001) {
			console.log(reason)
			process.exit(1)
		}
		console.log(`disconnected from ${server}; retrying…`)
		setTimeout(connect, 2000)
	}
	socket.onerror = () => {}
}

// The server runs a newer runner. Its updater fetches it when this one exits with 75; one started by hand carries on.
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
