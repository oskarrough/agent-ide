/** The runner protocol, both ends */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { ExecutionError, FileError } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { writePiSession } from './modules/pi-sessions.js'

/** What a runner is made of, as the server ships it */
const RUNNER_FILES = [
	'runner.js',
	'remote.js',
	'modules.js',
	'modules/status.js',
	'modules/context.js',
	'modules/pi-sessions.js',
]
const RUNNER_PACKAGES = [
	'@earendil-works/chord',
	'@earendil-works/pi-ai',
	'@earendil-works/pi-coding-agent',
	'@earendil-works/pi-durable',
]
export async function runnerBundle(dir) {
	const read = (file) => readFile(path.join(dir, file), 'utf8')
	const files = Object.fromEntries(
		await Promise.all(RUNNER_FILES.map(async (file) => [file, await read(file)])),
	)
	const require = createRequire(path.join(dir, 'package.json'))
	const dependencies = Object.fromEntries(
		await Promise.all(
			RUNNER_PACKAGES.map(async (packageName) => {
				// These manifests needn't be exported. Node's search paths also work in Bun runners.
				const file = require.resolve
					.paths(packageName)
					.map((root) => path.join(root, packageName, 'package.json'))
					.find(existsSync)
				return [packageName, JSON.parse(await readFile(file, 'utf8')).version]
			}),
		),
	)
	return {
		version: createHash('sha256')
			.update(JSON.stringify([files, dependencies]))
			.digest('hex')
			.slice(0, 12),
		files,
		dependencies,
	}
}

function encode(value) {
	return JSON.stringify(value, (key, item) => {
		if (item instanceof Uint8Array) return { $bytes: Buffer.from(item).toString('base64') }
		if (item instanceof FileError || item instanceof ExecutionError)
			return {
				$error: item.constructor.name,
				code: item.code,
				message: item.message,
				path: item.path,
				spillPath: item.spillPath,
			}
		return item
	})
}
function decode(text) {
	return JSON.parse(text, (key, item) => {
		if (item?.$bytes !== undefined) return new Uint8Array(Buffer.from(item.$bytes, 'base64'))
		if (item?.$error === 'FileError') return new FileError(item.code, item.message, item.path)
		if (item?.$error === 'ExecutionError')
			return Object.assign(
				new ExecutionError(item.code, item.message),
				item.spillPath ? { spillPath: item.spillPath } : {},
			)
		return item
	})
}

const READERS = {
	openTextLineReader: ['readLine', 'close'],
	openBinaryReader: ['info', 'read', 'scanLines', 'close'],
	openDirReader: ['next', 'close'],
}
const CHANGES = [
	'writeFile',
	'appendFile',
	'truncateFile',
	'renameFile',
	'createDir',
	'remove',
	'exec',
]
const FS = [
	'absolutePath',
	'joinPath',
	'readTextFile',
	'readTextLines',
	'readBinaryFile',
	'writeFile',
	'appendFile',
	'truncateFile',
	'flushFile',
	'renameFile',
	'fileInfo',
	'listDir',
	'canonicalPath',
	'exists',
	'createDir',
	'remove',
	'createTempDir',
	'createTempFile',
	...Object.keys(READERS),
]

/**
 * A runner's connection goes `authenticating` → `registering` → `online` → `closed`, and only an online one takes
 * calls. One map holds each name's current connection; a newer one for the name closes the old, and a closed one
 * never comes back.
 * @typedef {{ name: string, phase: 'authenticating' | 'registering' | 'online' | 'closed', end: (code?: number, reason?: string) => void, send?: (value: unknown) => void, held?: Map<string, unknown[]> }} Connection
 */
export function createRunners({ onChange }) {
	/** @type {Map<string, Connection>} */
	const connections = new Map()
	const waiting = new Map()
	const calls = new Map()
	let next = 0
	const current = (name) => {
		const connection = connections.get(name)
		return connection?.phase === 'online' ? connection : undefined
	}

	function online(name, signal) {
		signal?.throwIfAborted()
		if (current(name)) return Promise.resolve()
		return new Promise((resolve, reject) => {
			const done = (fn) => () => {
				const pending = waiting.get(name)
				pending?.delete(ready)
				if (!pending?.size) waiting.delete(name)
				signal?.removeEventListener('abort', cancel)
				fn(signal?.reason)
			}
			const ready = done(resolve)
			const cancel = done(reject)
			waiting.set(name, (waiting.get(name) ?? new Set()).add(ready))
			signal?.addEventListener('abort', cancel, { once: true })
		})
	}

	/** `message` can be a function of what the connection holds, made as it is sent */
	async function call(name, message, { signal, onMessage }) {
		signal?.throwIfAborted()
		await online(name, signal)
		signal?.throwIfAborted()
		const id = ++next
		if (typeof message === 'function') message = message(current(name).held)
		return new Promise((resolve, reject) => {
			const done = (fn) => (value) => {
				calls.delete(id)
				signal?.removeEventListener('abort', cancel)
				onChange()
				fn(value)
			}
			const cancel = () => {
				// The runner is told to stop, but local cancellation never waits for its reply.
				done(reject)(signal.reason ?? new Error('aborted'))
				current(name)?.send({ id, op: 'cancel' })
			}
			calls.set(id, {
				runner: name,
				op: message.op,
				what: message.model ?? message.method,
				onMessage,
				resolve: done(resolve),
				reject: done(reject),
			})
			signal?.addEventListener('abort', cancel, { once: true })
			current(name).send({ id, ...message })
			onChange()
		})
	}

	/** Closes a connection; only the name's current one takes its calls down with it. True when it was current. */
	function disconnect(connection) {
		const was = connection.phase
		connection.phase = 'closed'
		if (connections.get(connection.name) !== connection) return false
		connections.delete(connection.name)
		if (was === 'online')
			for (const pending of [...calls.values()])
				if (pending.runner === connection.name)
					pending.reject(new Error(`runner ${connection.name}: connection lost`))
		return true
	}

	return {
		call,
		online,
		isOnline: (name) => Boolean(current(name)),
		tell: (name, message) => current(name)?.send(message),
		working: (name) =>
			[...calls.values()]
				.filter((call) => call.runner === name)
				.map(({ op, what }) => ({ op, what })),
		/** A connection that has yet to show its key; `end` closes its socket, with a code or at once */
		connection: (name, end = () => {}) => ({ name, phase: 'authenticating', end }),
		/** Its key held: it takes the name, and the name's older connection ends */
		register(connection) {
			if (connection.phase !== 'authenticating') return false
			const old = connections.get(connection.name)
			if (old) (disconnect(old), old.end())
			connection.phase = 'registering'
			connections.set(connection.name, connection)
			return true
		},
		/** Registered and still current: it takes calls from now on */
		connect(connection, send) {
			if (connection.phase !== 'registering') return false
			connection.send = (value) => send(encode(value))
			connection.held = new Map()
			connection.phase = 'online'
			for (const resolve of waiting.get(connection.name) ?? []) resolve()
			waiting.delete(connection.name)
			return true
		},
		disconnect,
		/** Cuts off the name's connection at once, whatever its phase, so it never comes online */
		kick(name, code, reason) {
			const connection = connections.get(name)
			if (connection && disconnect(connection)) connection.end(code, reason)
		},
		receive(text) {
			const message = decode(text)
			const pending = calls.get(message.id)
			if (!pending) return
			if ('result' in message) pending.resolve(message.result)
			else if ('error' in message) pending.reject(new Error(message.error))
			else pending.onMessage?.(message)
		},
	}
}

function failure(model, partial, message, aborted) {
	return {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...partial,
		stopReason: aborted ? 'aborted' : 'error',
		errorMessage: message,
	}
}

/** Both ends of a connection keep the conversations of its last few sessions, by the same rule in the same order, so they always agree on what the runner holds */
function keep(kept, key, messages) {
	kept.delete(key)
	kept.set(key, messages)
	if (kept.size > 16) kept.delete(kept.keys().next().value)
}
/** Pi hands over the same message objects turn after turn, so each is encoded once */
const encoded = new WeakMap()
const encodeOnce = (message) =>
	encoded.get(message) ?? encoded.set(message, encode(message)).get(message)

/** The models pi on the runner resolved, by `provider/id` */
export function runnerProvider(runners, name, resolved = {}) {
	const id = `runner:${name}`
	const models = Object.entries(resolved).map(([ref, model]) => ({
		...model,
		provider: id,
		id: ref,
		name: `${model.name} on ${name}`,
	}))
	const stream = (model, context, options = {}) => {
		const events = createAssistantMessageEventStream()
		const {
			signal,
			apiKey,
			env,
			fetch,
			onPayload,
			onResponse,
			onProviderStreamEvent,
			telemetry,
			...rest
		} = options
		let partial
		/** A call sends only the messages since the session's last, when the connection holds that one */
		const send = (held) => {
			const key = rest.sessionId
			const sent = context.messages.map(encodeOnce)
			const last = held.get(key)
			const since =
				last?.length <= sent.length && last.every((message, index) => message === sent[index])
					? last.length
					: 0
			if (key) keep(held, key, sent)
			const messages = context.messages.slice(since)
			return { op: 'stream', model: model.id, context: { messages, since }, options: rest }
		}
		runners
			.call(name, send, {
				signal,
				/** The runner sends the growing message only now and then; deltas in between reuse the last */
				onMessage: ({ event }) => {
					if (event.partial) partial = event.partial
					else if (!['done', 'error'].includes(event.type)) event.partial = partial
					events.push(event)
				},
			})
			.catch((error) =>
				events.push({
					type: 'error',
					reason: signal?.aborted ? 'aborted' : 'error',
					error: failure(model, partial, error.message, signal?.aborted),
				}),
			)
			.finally(() => events.end())
		return events
	}
	return {
		id,
		name: `runner ${name}`,
		auth: {
			apiKey: {
				name: `login on ${name}`,
				resolve: async () => ({ auth: {}, source: `runner ${name}` }),
			},
		},
		getModels: () => models,
		stream,
		streamSimple: stream,
	}
}

export function remoteEnv(runners, name, cwd) {
	const env = { id: `runner:${name}`, cwd }
	const request = (message, context) =>
		runners
			.call(name, message, { signal: context?.abortSignal })
			.catch((error) => ({ ok: false, error: new FileError('unknown', error.message) }))
	const reader = (handle, methods) =>
		Object.fromEntries(
			methods.map((method) => [
				method,
				(...args) => {
					const context = args.pop()
					return request({ op: 'handle', handle, method, args }, context)
				},
			]),
		)
	for (const method of FS) {
		env[method] = async (...args) => {
			const context = args.pop()
			const result = await request({ op: 'env', cwd, method, args }, context)
			return result.ok && READERS[method]
				? { ok: true, value: reader(result.value.handle, READERS[method]) }
				: result
		}
	}
	env.exec = async (command, options = {}, context) => {
		const { onOutput, ...rest } = options
		return runners
			.call(
				name,
				{ op: 'env', cwd, method: 'exec', args: [command, rest] },
				{
					signal: context?.abortSignal,
					onMessage: ({ output }) => onOutput?.(output.text, context, output.info),
				},
			)
			.catch((error) => ({
				ok: false,
				error: new ExecutionError(
					context?.abortSignal?.aborted ? 'aborted' : 'unknown',
					error.message,
				),
			}))
	}
	env.watch = async () => ({
		ok: false,
		error: new FileError('not_supported', 'Watching is not supported on a runner'),
	})
	env.cleanup = async () => {}
	return env
}

/** Whether a path is one of `folders` or inside one: the folders a runner offers */
export const within = (folders, target) =>
	folders.some((folder) => target === folder || target.startsWith(folder + path.sep))

/** `resolve(pattern)` is pi's `--model pattern`: { model, thinkingLevel? */
export function serveRunner({
	name,
	dir,
	roots = [dir],
	readable = () => [],
	models,
	resolve,
	echo,
	ops: more = {},
	readOnly = false,
	send,
	onTell,
}) {
	const running = new Map()
	const handles = new Map()
	const kept = new Map()
	const connection = randomUUID()
	let nextHandle = 0
	let stopped = false
	const reply = (value) => !stopped && send(encode(value))
	const ops = {
		...more,
		resolve: ({ model }) => resolved(model),
		/** A conversation's new entries, appended to its pi session file; the folder must be one the runner offers */
		'pi-session': async ({ session, cwd, entries }) => {
			if (readOnly) throw new Error(`${name} is read-only`)
			return writePiSession({ session, cwd: inside(cwd), entries })
		},
		stream: (message, context) => stream(message, context.abortSignal),
		env,
		handle,
	}

	/** `reading` also reaches the folders `readable()` lists, like the skills an agent was shown */
	function inside(target, cwd = dir, reading = false) {
		const full = path.resolve(cwd, target ?? '.')
		if (!within(roots, full) && !(reading && within(readable(), full)))
			throw new FileError(
				'permission_denied',
				`${target} is outside ${name}'s folders ${roots.join(', ')}`,
				target,
			)
		return full
	}

	/** A model goes to the server without its headers, which can hold credentials */
	async function resolved(pattern) {
		const {
			model: { headers, ...model },
			thinkingLevel,
			defaultThinkingLevel,
		} = await resolve(pattern)
		return {
			model,
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
		}
	}

	async function stream({ id, model: ref, context, options }, signal) {
		const messages = [...(context.since ? kept.get(options.sessionId) : []), ...context.messages]
		if (options.sessionId) keep(kept, options.sessionId, messages)
		context = { messages: messages.filter((message) => !saidNothing(message)) }
		let { model } = await resolve(ref)
		if (model.provider === 'echo') {
			echo.appendResponses([
				(ctx) =>
					fauxAssistantMessage(
						`echo@${name} heard: ${messageText(ctx.messages.findLast((message) => message.role === 'user'))}`,
					),
			])
			model = echo.getModel()
		}
		const said = messages.findLast(
			(message) => message.role === 'assistant' && message.stopReason !== 'error',
		)
		// Without a session id pi-claude-code starts a fresh Claude Code process instead of the warm one.
		if (model.provider === 'claude-code' && said && quiet(said))
			options = { ...options, sessionId: undefined }
		let sentAt = 0
		for await (const event of models.streamSimple(model, context, { ...options, signal })) {
			const due =
				['start', 'done', 'error'].includes(event.type) ||
				event.type.endsWith('_end') ||
				Date.now() - sentAt > 100
			const { partial, ...slim } = event
			if (due && partial) sentAt = Date.now()
			reply({ id, event: due ? event : slim })
		}
	}

	async function env({ id, cwd, method, args }, context) {
		const root = inside(cwd)
		if (readOnly && CHANGES.includes(method)) {
			const message = `${name} is read-only: it reads its folder but changes nothing and runs no commands`
			return {
				ok: false,
				error:
					method === 'exec'
						? new ExecutionError('spawn_error', message)
						: new FileError('permission_denied', message, args[0]),
			}
		}
		const local = new NodeExecutionEnv({ cwd: root })
		if (method === 'exec') {
			const [command, options = {}] = args
			return local.exec(
				command,
				{
					...options,
					cwd: inside(options.cwd, root),
					onOutput: (text, _context, info) => reply({ id, output: { text, info } }),
				},
				context,
			)
		}
		if (method === 'createTempDir' || method === 'createTempFile')
			throw new FileError('permission_denied', `Temporary files are outside ${name}'s folder`)
		if (method !== 'joinPath') args[0] = inside(args[0], root, !CHANGES.includes(method))
		if (method === 'renameFile') args[1] = inside(args[1], root)
		const result = await local[method](...args, context)
		if (result.ok && READERS[method]) {
			if (stopped) {
				await result.value.close(BACKGROUND_CONTEXT)
				throw new FileError('invalid', 'That runner connection is closed')
			}
			// A reader belongs to this connection, even when the next one reuses its number.
			const handle = `${connection}:${++nextHandle}`
			handles.set(handle, result.value)
			return { ok: true, value: { handle } }
		}
		return result
	}

	async function handle({ handle: key, method, args }, context) {
		const target = handles.get(key)
		if (!target) return { ok: false, error: new FileError('invalid', 'That reader is closed') }
		if (method === 'close') handles.delete(key)
		return target[method](...args, context)
	}

	return {
		receive(text) {
			if (stopped) return
			const message = decode(text)
			if (message.id === undefined) return onTell?.(message)
			if (message.op === 'cancel')
				return running.get(message.id)?.cancel(new Error('cancelled by the server'))
			const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
			running.set(message.id, { cancel })
			;(ops[message.op] ?? (async () => null))(message, context)
				.then(
					(result) => reply({ id: message.id, result: result ?? null }),
					(error) => {
						if (error instanceof FileError) reply({ id: message.id, result: { ok: false, error } })
						else reply({ id: message.id, error: error.message })
					},
				)
				.finally(() => running.delete(message.id))
		},
		async stopAll() {
			stopped = true
			for (const { cancel } of running.values()) cancel(new Error('server disconnected'))
			running.clear()
			const readers = [...handles.values()]
			handles.clear()
			await Promise.all(readers.map((reader) => reader.close(BACKGROUND_CONTEXT)))
		},
	}
}

const text = (message) =>
	typeof message?.content === 'string'
		? message.content
		: (message?.content ?? [])
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('')

/**
 * Claude Code writes `(no content)` for a reply with no text, then drops that reply when the history comes back,
 * so pi-claude-code finds one user message fewer than pi has and refuses every later turn
 * after that empty reply. It means the agent said nothing.
 */
const saidNothing = (message) =>
	message?.role === 'assistant' &&
	Array.isArray(message.content) &&
	message.content.every((part) => part.type === 'text') &&
	text(message) === '(no content)'

export const messageText = (message) => (saidNothing(message) ? '' : text(message))

/**
 * A reply with no text and no tool call. A warm Claude Code process folds the next message into the one before such
 * a reply, so pi-claude-code again counts one user message fewer than pi; a fresh process replays it right.
 */
const quiet = (message) =>
	saidNothing(message) ||
	!message.content.some(
		(part) => (part.type === 'text' && part.text.trim()) || part.type === 'toolCall',
	)
