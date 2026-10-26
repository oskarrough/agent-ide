// Matrix rooms as agent-ide threads. Every message posts once into its room's thread, or its Matrix thread's, even
// across restarts. Only MATRIX_USERS ask anyone: a mention asks MATRIX_AGENT and starts a Matrix thread, anything else
// asks whom the thread last asked. Answers go back to the room in order, and a fork sends nothing.
//
// Setting it up:
//   1. Give the bot its own account on any homeserver, and get a token for it:
//        curl -s https://matrix-client.matrix.org/_matrix/client/v3/login -d '{"type":"m.login.password",
//          "identifier":{"type":"m.id.user","user":"BOT"},"password":"PASSWORD"}'
//      Its `access_token` is MATRIX_TOKEN.
//   2. Invite it to a room without end-to-end encryption, which the bridge can't read.
//   3. MATRIX=1 MATRIX_TOKEN=… MATRIX_ROOMS='#room:matrix.org' MATRIX_USERS='@you:matrix.org' \
//        MATRIX_AGENT=sonnet@laptop MATRIX_BRIEF='File it with `gh issue create`; answer with the link.' bun server.js
//      ROOMS and USERS take several, comma-separated. AGENT is model@runner, or a runner for its default model.
//   4. Write `@BOT …` in the room. Its thread shows up in the client, titled `matrix #room:matrix.org: …`.
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { agentTo, speaker } from './util.js'

// `threads` keys a room by its id and a Matrix thread by its root event; `last` is each room's newest send.
const MatrixBridge = defineDoc({
	kind: 'agent-ide.matrix.bridge',
	version: 1,
	scope: 'session',
	checkpointWhen: () => true,
	initial: () => ({ since: '', threads: {}, last: {}, salt: '' }),
})
const finished = (status = 'completed') => ({
	status: 'terminal',
	outcome: { status, result: null },
})
const background = (threadId) => ({
	ownership: { kind: 'conversation' },
	conversationId: threadId,
	background: true,
})
const list = (name) =>
	(process.env[name] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
const sleep = (ms, signal) =>
	new Promise((r) => {
		const t = setTimeout(r, ms)
		signal?.addEventListener('abort', () => (clearTimeout(t), r()))
	})
// A no that asking again won't change.
const refused = (error) => error.status >= 400 && error.status < 500 && error.status !== 429
// Anyone in a room can write: no terminal escapes, control characters or bidi overrides reach an agent.
const clean = (text) =>
	text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')

export function server(core) {
	const {
		MATRIX_HOMESERVER: home = 'https://matrix-client.matrix.org',
		MATRIX_TOKEN: token,
		MATRIX_AGENT: agent,
		MATRIX_BRIEF: brief,
	} = process.env
	const names = list('MATRIX_ROOMS')
	const users = new Set(list('MATRIX_USERS').map(speaker))
	if (!token || !names.length)
		throw new Error('MATRIX=1 needs MATRIX_TOKEN and MATRIX_ROOMS: see matrix.js')

	async function request(method, route, body, signal) {
		const res = await fetch(`${home.replace(/\/$/, '')}/_matrix/client${route}`, {
			method,
			signal,
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: body && JSON.stringify(body),
		})
		if (!res.ok) {
			const text = await res.text()
			const retryAfter = res.status === 429 ? JSON.parse(text || '{}').retry_after_ms : undefined
			throw Object.assign(
				new Error(`Matrix ${method} ${route.split('?')[0]}: ${res.status} ${text}`),
				{ status: res.status, retryAfter },
			)
		}
		return res.json()
	}
	const roomPath = (room) => `/v3/rooms/${encodeURIComponent(room)}`

	const MatrixSend = defineTask({
		name: 'agent-ide.matrix.send',
		version: 1,
		initial: ({ after }) => ({ phase: after ? 'wait' : 'send' }),
		phases: {
			wait: ({ input: { after } }, rt, ctx) =>
				rt.commit(
					() => ({
						status: 'waiting',
						checkpoint: { phase: 'send' },
						on: [after],
						policy: 'allSettled',
					}),
					ctx,
				),
			async send({ input: { room, root, txn, body } }, rt, ctx) {
				const content = {
					msgtype: 'm.text',
					body: body.slice(0, 30000),
					...(root
						? {
								'm.relates_to': {
									rel_type: 'm.thread',
									event_id: root,
									is_falling_back: true,
									'm.in_reply_to': { event_id: root },
								},
							}
						: {}),
				}
				for (let wait = 1000; !rt.signal.aborted; wait = Math.min(wait * 2, 60000)) {
					try {
						await request(
							'PUT',
							`${roomPath(room)}/send/m.room.message/${txn}`,
							content,
							AbortSignal.any([rt.signal, AbortSignal.timeout(60000)]),
						)
						break
					} catch (error) {
						console.error(`matrix send: ${error.message}`)
						if (refused(error)) break
						await sleep(error.retryAfter ?? wait, rt.signal)
					}
				}
				await rt.commit(() => finished(), ctx)
			},
		},
		abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})

	async function posted(tx, threadId, { id, data }) {
		if (!data.answer && !data.error) return
		const bridge = await tx.doc(MatrixBridge)
		const { room, root } = Object.values(bridge.threads).find((t) => t.thread === threadId) ?? {}
		if (!room) return
		bridge.salt ||= crypto.randomUUID()
		bridge.last[room] = await tx.createTask(
			MatrixSend,
			{
				room,
				root,
				txn: `agent-ide-${bridge.salt}-${threadId}-${id}`,
				body: data.body,
				after: bridge.last[room],
			},
			background(threadId),
		)
	}

	/**
	 * @typedef {{ id: string, room: string, root: string, author: string, body: string, asks: boolean }} MatrixMessage
	 *   `root` is its Matrix thread's first event, or its own.
	 */
	let me, mentioned, rooms, to
	const state = () =>
		core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MatrixBridge))))

	// Matrix shows a sender its own transaction ids, which is how the bridge knows what it sent.
	/** @returns {MatrixMessage | null} */
	function messageOf(room, e) {
		const relation = e.content?.['m.relates_to']
		if (
			e.type !== 'm.room.message' ||
			typeof e.content.body !== 'string' ||
			relation?.rel_type === 'm.replace' ||
			e.unsigned?.transaction_id
		)
			return null
		const mentions =
			e.content['m.mentions']?.user_ids?.includes(me) || mentioned.test(e.content.body)
		return {
			id: e.event_id,
			room,
			author: speaker(e.sender),
			body: clean(e.content.body),
			root: relation?.rel_type === 'm.thread' ? relation.event_id : e.event_id,
			asks: Boolean(agent && mentions && users.has(speaker(e.sender))),
		}
	}

	/** @returns {Promise<MatrixMessage[]>} */
	async function readBatch(batch, since) {
		const messages = []
		for (const [room, { timeline = {} }] of Object.entries(batch.rooms?.join ?? {}).filter(
			([room]) => rooms[room],
		)) {
			const events = [...(timeline.events ?? [])]
			for (let from = timeline.limited && timeline.prev_batch; from;) {
				const page = await request(
					'GET',
					`${roomPath(room)}/messages?dir=b&limit=100&from=${encodeURIComponent(from)}&to=${encodeURIComponent(since)}`,
				)
				events.unshift(...page.chunk.reverse())
				from = page.chunk.length && page.end
			}
			messages.push(...events.map((e) => messageOf(room, e)).filter(Boolean))
		}
		return messages
	}

	// May predate the bridge; one the homeserver won't show is left out.
	const firstOf = ({ room, root }) =>
		request('GET', `${roomPath(room)}/event/${encodeURIComponent(root)}`).then(
			(e) => messageOf(room, e),
			(error) => {
				if (refused(error)) return null
				throw error
			},
		)

	async function keep(tx, bridge, key, room, root, title) {
		const thread = await core.startThread(tx, 'matrix', title, null)
		bridge.threads[key] = { thread, room, root }
		return thread
	}

	/** @param {MatrixMessage} message */
	async function relay(message) {
		const { id, room, root, author, body, asks } = message
		const key = root !== id || asks ? root : room
		const { threads } = await state()
		if (!threads[key]) {
			const first = root !== id && (await firstOf(message))
			await core.commit(async (tx) => {
				const bridge = await tx.doc(MatrixBridge)
				const roomThread =
					bridge.threads[room]?.thread ??
					(await keep(tx, bridge, room, room, '', `matrix ${rooms[room]}`))
				if (key === room) return
				if (root === id) await core.post(tx, roomThread, { author, body })
				const thread = await keep(
					tx,
					bridge,
					key,
					room,
					root,
					`matrix ${rooms[room]}: ${(first || message).body.slice(0, 60)}`,
				)
				await core.post(tx, thread, {
					author: 'matrix',
					body: [
						brief,
						`This is a Matrix thread in ${rooms[room]}, whose own chat is thread ${roomThread}.`,
					]
						.filter(Boolean)
						.join('\n\n'),
				})
				if (first) await core.post(tx, thread, { author: first.author, body: first.body })
			})
		}
		const asked = asks
			? [(to ??= await address())]
			: users.has(author)
				? await core.lastAsked((await state()).threads[key].thread)
				: []
		await core.once(`matrix ${id}`, 'matrix', async (tx) =>
			core.post(
				tx,
				(await tx.doc(MatrixBridge)).threads[key].thread,
				{ author, body, ...(asked.length ? { to: asked } : {}) },
				{ steer: true },
			),
		)
	}

	// A runner that never connected can't name its model yet, so this waits for it.
	async function address() {
		const asked = agentTo(agent)
		return core
			.address(asked)
			.catch(async () => (await core.runners.online(asked.runner), core.address(asked)))
	}

	async function retry(what, fn) {
		for (;;) {
			try {
				return await fn()
			} catch (error) {
				console.error(`matrix ${what}: ${error.message}`)
				await sleep(5000)
			}
		}
	}

	async function sync() {
		me = (await retry('whoami', () => request('GET', '/v3/account/whoami'))).user_id
		// `@bot` mentions it, but `@bottle` doesn't.
		const local = me.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		mentioned = new RegExp(`${local}(?![\\w-])`)
		rooms = {}
		for (const name of names)
			rooms[
				(
					await retry('join', () => request('POST', `/v3/join/${encodeURIComponent(name)}`, {}))
				).room_id
			] = name
		const filter = encodeURIComponent(
			JSON.stringify({
				presence: { types: [] },
				account_data: { types: [] },
				room: {
					rooms: Object.keys(rooms),
					timeline: { types: ['m.room.message'] },
					state: { types: [] },
					ephemeral: { types: [] },
				},
			}),
		)
		let { since } = await state()
		for (;;)
			since = await retry('sync', async () => {
				const batch = await request(
					'GET',
					`/v3/sync?timeout=30000&filter=${filter}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
					undefined,
					AbortSignal.timeout(40000),
				)
				const messages = since ? await readBatch(batch, since) : []
				for (const message of messages) await relay(message)
				if (!since || messages.length)
					await core.commit(async (tx) => {
						;(await tx.doc(MatrixBridge)).since = batch.next_batch
					})
				return batch.next_batch
			})
	}
	sync()

	return { extension: defineExtension({ name: 'agent-ide.matrix', tasks: [MatrixSend] }), posted }
}
