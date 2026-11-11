/** Writes each agent's conversation as a pi session file on its runner, in the folder's own sessions directory, so `pi --resume` there lists it and carries on.
 * Off by default; MODULES=+pi-sessions turns it on. One file per conversation, so a fork starts its own on its first message,
 * and a file only grows, as entries commit; a runner that was offline writes what it missed when it comes back.
 * Nothing flows the other way: what someone adds to a file in pi, agent-ide never reads.
 * A runner writes where pi would: `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting there, else `~/.pi/agent/sessions/--<folder>--/`.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
	CURRENT_SESSION_VERSION,
	getAgentDir,
	parseSessionEntries,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { ProviderDoc } from '@earendil-works/pi-durable'

export const on = false

/** Conversations the server follows, `conversation` → { session, seen, last, where }; a tick looks only at the newest entry of each */
export function server(core) {
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

	return {
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
