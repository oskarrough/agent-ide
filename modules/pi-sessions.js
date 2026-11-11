/** Writes each agent's conversation as a pi session file on its runner, in the folder's own sessions directory, so `pi --resume` there lists it and carries on, and starts a thread from a pi session there.
 * Off by default; MODULES=+pi-sessions turns it on. One file per conversation, so a fork starts its own on its first message,
 * and a file only grows, as entries commit; a runner that was offline writes what it missed when it comes back.
 * Nothing syncs: what someone adds to a file in pi, agent-ide never reads. `GET /api/pi-sessions?runner=r&dir=d` lists a folder's pi sessions and
 * `POST /api/pi-sessions {runner, dir?, session, title?, author?}` copies one's active branch into a new thread; importing again after more work in pi makes another thread.
 * A runner writes where pi would: `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting there, else `~/.pi/agent/sessions/--<folder>--/`.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
	CURRENT_SESSION_VERSION,
	getAgentDir,
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import {
	AssistantEntry,
	CompactionEntry,
	defineDoc,
	ProviderDoc,
	ToolResultEntry,
} from '@earendil-works/pi-durable'

export const on = false

/** Conversations the server follows, `conversation` → { session, seen, last, where }; a tick looks only at the newest entry of each */
export async function server(core) {
	// Server-only files, which a runner doesn't have
	const { AGENT, speaker, writtenTo } = await import('../util.js')
	const { defaultTitle } = await import('../apps/client/title.js')
	/** Where a thread's agent conversation came from, so its details can say */
	const Source = defineDoc({
		kind: 'agent-ide.pi-session-source',
		version: 1,
		scope: 'conversation',
		history: 'latest',
		fork: 'initial',
		checkpointWhen: () => true,
		initial: () => ({ from: null }),
	})
	const followed = new Map()
	const touched = new Set()
	/** Pi has no place for a reset, and a system message would put agent-ide's tools where pi's own belong */
	const sendable = (entry) => entry.kind !== 'pi.system' && entry.kind !== 'pi.reset' && entry.model

	async function push(conversation, state) {
		const to = await core.agentOf(conversation)
		const runner = to && (await core.known())[to.runner]
		if (!runner) return
		const cwd = path.resolve(runner.dir, to.dir ?? '.')
		const where = `${to.runner} ${cwd}`
		// The conversation's own session identity, a UUID that pi uses the same way; a fork has a fresh one
		state.session ??= await core.commit(
			async (tx) => (await tx.doc(ProviderDoc, conversation)).sessionId,
		)
		const { session } = state
		const send = (entries) =>
			core.runners.call(to.runner, { op: 'pi-session', session, cwd, entries }, {})
		// A new runner or folder starts from what its own file holds
		if (state.where !== where) {
			state.where = where
			const reply = await send([])
			if (!reply) throw new Error(`${to.runner} doesn't write pi sessions; update it`)
			state.last = reply.last
		}
		for (let cursor; ;) {
			const page = await core.commit((tx) =>
				tx.scanEntries(
					{ conversationId: conversation, minEntryId: state.last + 1, order: 'ascending' },
					100,
					cursor,
				),
			)
			const entries = page.items.filter(sendable).map(({ id, kind, model, head }) => ({
				id,
				kind,
				model,
				head,
			}))
			if (entries.length) state.last = (await send(entries)).last
			if (page.items.length) state.seen = page.items.at(-1).id
			if (!page.next) return
			cursor = page.next
		}
	}

	/** One push at a time per conversation; a change meanwhile means one more after it */
	async function sync(conversation, state) {
		if (state.running) return void (state.again = true)
		state.running = true
		try {
			do {
				state.again = false
				const to = await core.agentOf(conversation)
				if (!to) continue
				try {
					const newest = await core.commit((tx) => tx.latestEntryId(conversation))
					if (newest === undefined || newest <= state.seen) continue
					await core.runners.online(to.runner)
					await push(conversation, state)
				} catch (error) {
					state.where = undefined
					console.error(`pi-sessions: conversation ${conversation}: ${error.message}`)
					// A runner that dropped comes back to the same push; any other failure waits for the next change
					state.again = !core.runners.isOnline(to.runner)
				}
			} while (state.again)
		} finally {
			state.running = false
		}
	}

	async function follow(threadId) {
		const row = await core.thread(threadId)
		if (!row) return
		for (const { conversation } of Object.values(row.agents))
			if (!followed.has(conversation)) followed.set(conversation, { seen: 0, last: 0 })
	}

	const COMPACTED = [
		'The conversation history before this point was compacted into the following summary:\n\n<summary>\n',
		'\n</summary>',
	]
	const textOf = (content) =>
		typeof content === 'string'
			? content
			: (content ?? [])
					.filter((part) => part.type === 'text')
					.map((part) => part.text)
					.join('')

	/** The runner's folder a request names; sessions are read only on runners that take work from anyone */
	async function folderOf({ runner: name, dir }) {
		const runner = name && (await core.known())[name]
		if (!runner) throw new Error(`No runner named ${name}`)
		if (runner.owner)
			throw new Error(`${name} has an owner, so its pi sessions are not listed here`)
		if (!core.runners.isOnline(name)) throw new Error(`${name} is offline`)
		const cwd = path.resolve(runner.dir, dir || '.')
		if (
			![...(runner.folders ?? [runner.dir])].some(
				(folder) => cwd === folder || cwd.startsWith(folder + path.sep),
			)
		)
			throw new Error(`${dir} is outside ${name}'s folders`)
		return { name, cwd }
	}

	/** A pi session's active branch, copied into a new thread: the user's messages as the thread's, the agent's last words of each turn as its answers */
	async function bring({ runner, dir, session, title, author }) {
		const { name, cwd } = await folderOf({ runner, dir })
		const listed = await core.runners.call(name, { op: 'pi-session-list', cwd }, {})
		const found = listed?.find((info) => info.path === session || info.id === session)
		if (!found) throw new Error(`${name} has no pi session ${session} for ${cwd}`)
		const read = await core.runners.call(name, { op: 'pi-session-read', cwd, file: found.path }, {})
		const branch = read.entries
		const first = branch.find((entry) => entry.type === 'message' && entry.message.role === 'user')
		if (!first) throw new Error('That session has no messages to bring')
		const asked = { runner: name, dir: cwd }
		const level = read.thinkingLevel ? { thinkingLevel: read.thinkingLevel } : {}
		/** The session's own model, or the runner's default when it hasn't that one */
		const to = await core
			.address({
				...asked,
				model: read.model && `${read.model.provider}/${read.model.modelId}`,
				...level,
			})
			.catch(() => core.address(asked))
		const who = speaker(author ?? 'pi')
		const heading = title?.trim() || read.name || defaultTitle(textOf(first.message.content))
		const thread = await core.commit(async (tx) => {
			const threadId = await core.startThread(tx, heading, null, null)
			const agent = await core.newAgent(tx, threadId, [])
			await core.setUp(tx, agent.conversation, threadId, to)
			const mapped = new Map()
			const put = (entry, id) => mapped.set(entry.id, id)
			const keeps = []
			for (const entry of branch) {
				const message =
					entry.type === 'custom_message'
						? { role: 'user', content: entry.content, timestamp: Date.parse(entry.timestamp) }
						: entry.type === 'message'
							? entry.message
							: undefined
				if (entry.type === 'compaction') {
					const earlier = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId)
					const head = branch
						.slice(Math.max(earlier, 0), branch.indexOf(entry))
						.map((candidate) => mapped.get(candidate.id))
						.find((id) => id !== undefined)
					const summary = {
						role: 'user',
						content: `${COMPACTED[0]}${entry.summary}${COMPACTED[1]}`,
						timestamp: Date.parse(entry.timestamp),
					}
					const kept = await tx.appendEntry(CompactionEntry, agent.conversation, {
						model: [summary],
						data: { reason: 'manual' },
						head: head ?? 'self',
					})
					put(entry, kept.id)
				} else if (message?.role === 'user') {
					const parts = Array.isArray(message.content) ? message.content : []
					const images = parts.filter((part) => part.type === 'image')
					const sent = await core.post(tx, threadId, {
						author: who,
						body: textOf(message.content),
						...(images.length ? { images } : {}),
					})
					const placed = await tx.appendEntry(agent.conversation, {
						kind: 'agent-ide.delivery',
						data: { held: [sent.entry] },
						model: [message],
					})
					put(entry, placed.id)
				} else if (message?.role === 'assistant') {
					const placed = await tx.appendEntry(AssistantEntry, agent.conversation, {
						model: [message],
					})
					put(entry, placed.id)
					const said = textOf(message.content)
					if (said.trim() && !message.content.some?.((part) => part.type === 'toolCall'))
						await core.post(tx, threadId, {
							author: writtenTo(to),
							body: said,
							answer: { conversation: agent.conversation, entry: placed.id },
						})
				} else if (message?.role === 'toolResult') {
					const placed = await tx.appendEntry(ToolResultEntry, agent.conversation, {
						model: [message],
						data: { diagnostics: [] },
					})
					put(entry, placed.id)
				}
			}
			;(await core.threadIn(tx, threadId)).agents[AGENT] = agent
			;(await tx.doc(Source, threadId)).from = {
				runner: name,
				file: found.path,
				session: found.id,
				...(read.name ? { name: read.name } : {}),
			}
			return threadId
		})
		return { id: thread }
	}

	/** `GET /api/pi-sessions?runner=r&dir=d` lists the pi sessions of a folder; `POST` with `session` brings one in; a thread's own says where it came from */
	async function serve(threadId, query, body) {
		if (threadId !== undefined) {
			if (body !== undefined)
				throw new Error('POST /api/pi-sessions {runner, session} starts a thread from a pi session')
			// Copied before it leaves the commit, as a document's values must be
			const from = await core.commit(async (tx) =>
				JSON.parse(JSON.stringify((await tx.doc(Source, threadId)).from ?? null)),
			)
			return { from }
		}
		if (body !== undefined) return bring(body)
		const { name, cwd } = await folderOf(Object.fromEntries(query))
		return core.runners.call(name, { op: 'pi-session-list', cwd }, {})
	}

	return {
		serve,
		/** Threads that just heard from someone: their agents are followed from the next tick */
		posted: (tx, threadId) => void touched.add(threadId),
		async changed() {
			const threads = [...touched]
			touched.clear()
			for (const threadId of threads) await follow(threadId).catch((error) => console.error(error))
			for (const [conversation, state] of followed)
				sync(conversation, state).catch((error) => console.error(error))
		},
	}
}

// ── The runner's half: a pi session file, appended to ─────────────────────

/** Each pi entry's id says which of the conversation's entries it came from: `i` for a message, `m` and `t` for the model and thinking it implied.
 * Pi's own ids are hex, so what someone adds in pi never looks like ours. */
const ours = (letter, entry) => `${letter}${entry.toString(16).padStart(7, '0')}`
const entryOf = (id) => (/^i[0-9a-f]{7}/.test(id) ? parseInt(id.slice(1, 8), 16) : undefined)

const SUMMARY_PREFIX =
	'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const SUMMARY_SUFFIX = '\n</summary>'

/** Where pi would keep this folder's sessions: its environment variable or setting, else under pi's agent folder */
function sessionDir(cwd) {
	const asked =
		process.env.PI_CODING_AGENT_SESSION_DIR || SettingsManager.create(cwd).getSessionDir()
	if (asked) return path.resolve(cwd, asked.replace(/^~(?=$|[/\\])/, os.homedir()))
	const safe = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, '')
		.replace(/[/\\:]/g, '-')}--`
	return path.join(getAgentDir(), 'sessions', safe)
}

/** Open sessions by folder and id: where agent-ide's own entries end */
const opened = new Map()

async function open(dir, id) {
	const found =
		existsSync(dir) && (await readdir(dir)).find((file) => file.endsWith(`_${id}.jsonl`))
	const state = { file: found && path.join(dir, found), leaf: null, last: 0, kept: [], tail: true }
	if (!found) return state
	const text = await readFile(state.file, 'utf8')
	state.tail = text.endsWith('\n')
	for (const entry of parseSessionEntries(text)) {
		// What pi added is a branch of its own; agent-ide carries on from its last entry
		if (entry.type === 'session' || !/^[imt][0-9a-f]{7}/.test(entry.id)) continue
		state.leaf = entry.id
		if (entry.type === 'model_change') state.model = `${entry.provider}/${entry.modelId}`
		if (entry.type === 'thinking_level_change') state.thinking = entry.thinkingLevel
		const from = entryOf(entry.id)
		if (from !== undefined) (state.kept.push(from), (state.last = Math.max(state.last, from)))
	}
	return state
}

const iso = (time) => new Date(time ?? Date.now()).toISOString()

/**
 * Appends what the conversation's `entries` add to its session file, and answers with the newest entry the file now has.
 * Entries it already has are skipped, so a repeat, or a catch-up after a break, changes nothing.
 * Which entries pi has no place for is decided here: the system messages never come, since pi would take their tools for its own.
 */
export async function writePiSession({ session, cwd, entries }) {
	const dir = sessionDir(cwd)
	const key = `${dir}\n${session}`
	const state = opened.get(key) ?? (await open(dir, session))
	opened.set(key, state)
	const lines = []
	const add = (entry) => {
		const line = { ...entry, parentId: state.leaf }
		state.leaf = entry.id
		lines.push(line)
	}
	const fresh = entries.filter((entry) => entry.id > state.last)
	for (const [index, entry] of fresh.entries()) {
		const [message] = entry.model ?? []
		if (!message) continue
		if (entry.kind === 'pi.compaction') {
			const summary = message.content?.[0]?.text ?? message.content ?? ''
			const kept = state.kept.find((from) => from >= entry.head)
			add({
				type: 'compaction',
				id: ours('i', entry.id),
				timestamp: iso(message.timestamp),
				summary: summary.replace(SUMMARY_PREFIX, '').replace(SUMMARY_SUFFIX, ''),
				firstKeptEntryId: kept === undefined ? ours('i', entry.id) : ours('i', kept),
				tokensBefore: 0,
			})
			state.kept.push(entry.id)
			state.last = entry.id
			continue
		}
		if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue
		// Pi starts a session with its model and thinking; here they are known once an assistant has answered, so look ahead
		const answer = state.model
			? message.role === 'assistant' && message
			: [message, ...fresh.slice(index + 1).flatMap((later) => later.model ?? [])].find(
					(candidate) => candidate.role === 'assistant',
				)
		if (answer) {
			const model = `${answer.provider}/${answer.model}`
			const timestamp = iso(answer.timestamp)
			if (model !== state.model) {
				state.model = model
				add({
					type: 'model_change',
					id: ours('m', entry.id),
					timestamp,
					provider: answer.provider,
					modelId: answer.model,
				})
			}
			if (answer.thinkingLevel && answer.thinkingLevel !== state.thinking) {
				state.thinking = answer.thinkingLevel
				add({
					type: 'thinking_level_change',
					id: ours('t', entry.id),
					timestamp,
					thinkingLevel: answer.thinkingLevel,
				})
			}
		}
		add({ type: 'message', id: ours('i', entry.id), timestamp: iso(message.timestamp), message })
		state.kept.push(entry.id)
		state.last = entry.id
	}
	if (!lines.length) return { last: state.last }
	if (!state.file) {
		const first = new Date(lines[0].timestamp).toISOString()
		state.file = path.join(dir, `${first.replace(/[:.]/g, '-')}_${session}.jsonl`)
		await mkdir(dir, { recursive: true })
		lines.unshift({
			type: 'session',
			version: CURRENT_SESSION_VERSION,
			id: session,
			timestamp: first,
			cwd,
		})
		state.tail = true
	}
	await appendFile(
		state.file,
		(state.tail ? '' : '\n') + lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
	)
	state.tail = true
	return { last: state.last }
}

/** The pi sessions of a folder, newest first, as pi lists them for `--resume` */
export async function listPiSessions({ cwd }) {
	const dir = sessionDir(cwd)
	if (!existsSync(dir)) return []
	const sessions = await SessionManager.list(cwd, dir)
	return sessions.map(({ path, id, name, firstMessage, modified, messageCount }) => ({
		path,
		id,
		...(name ? { name } : {}),
		firstMessage,
		modified,
		messageCount,
	}))
}

/** One of those sessions: its active branch from the root, and the model and thinking it ended on. Read as pi loads it, but never written back. */
export async function readPiSession({ cwd, file }) {
	const dir = sessionDir(cwd)
	const full = path.resolve(file)
	if (path.dirname(full) !== dir || !full.endsWith('.jsonl'))
		throw new Error(`${file} isn't one of ${cwd}'s pi sessions`)
	const entries = parseSessionEntries(await readFile(full, 'utf8'))
	migrateSessionEntries(entries)
	const session = SessionManager.inMemory(cwd, undefined, entries)
	if (path.resolve(session.getHeader()?.cwd ?? '') !== path.resolve(cwd))
		throw new Error(`${file} was started in another folder`)
	const { model, thinkingLevel } = session.buildSessionContext()
	return { name: session.getSessionName(), model, thinkingLevel, entries: session.getBranch() }
}
