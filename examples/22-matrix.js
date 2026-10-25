// The Matrix bridge, against a fake homeserver in this process. Every message lands once in the thread kept for its
// room or its Matrix thread. A mention by one of MATRIX_USERS asks the agent, in a Matrix thread of its own when it's
// top-level, and their later messages there ask it again. Answers and errors go back, in order, once, even across a
// restart with two of them in flight; a fork sends nothing.
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Database } from 'bun:sqlite'
import {
	api,
	call,
	check,
	db,
	done,
	say,
	scriptedRunner,
	server,
	sleep,
	text,
	until,
	view,
} from './lib.js'

const ROOM = '!room:fake'
const BOT = '@bot:fake'
const BRIEF = 'Answer what you heard.'
const events = []
const sends = []
const sent = new Map()
let synced = false
let held = false
const said = (sender, body, content = {}) => {
	events.push({
		room: ROOM,
		event_id: `$${events.length}`,
		sender,
		type: 'm.room.message',
		content: { msgtype: 'm.text', body, ...content },
	})
	return events.at(-1).event_id
}
const reply = (root) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } })
const fromBot = (root) =>
	events
		.filter(
			(e) =>
				e.sender === BOT &&
				(root === undefined || (e.content['m.relates_to']?.event_id ?? null) === root),
		)
		.map((e) => e.content.body)

// /sync's position is how many events there were, and like Synapse it gives at most ten, `limited`, from `p<position>`,
// before which /messages pages back five at a time. The first send of a "slow" answer lands but never answers, as if
// the server died right after the homeserver took it.
const hs = Bun.serve({
	port: 0,
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url)
		const route = url.pathname.replace(/^\/_matrix\/client\/v[13]/, '')
		if (req.headers.get('authorization') !== 'Bearer test-token')
			return Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 })
		if (route === '/account/whoami') return Response.json({ user_id: BOT })
		if (route.startsWith('/join/')) return Response.json({ room_id: ROOM })
		if (route === '/sync') {
			const since = url.searchParams.get('since')
			if (!since) return Response.json({ next_batch: String(events.length) })
			synced = true
			await until(async () => events.length > Number(since), 500, 20)
			const timeline = events.slice(Math.max(Number(since), events.length - 10))
			const cut = {
				limited: events.length - Number(since) > 10,
				prev_batch: `p${events.length - timeline.length}`,
			}
			return Response.json({
				next_batch: String(events.length),
				rooms: timeline.length
					? { join: { [ROOM]: { timeline: { events: timeline, ...cut } } } }
					: {},
			})
		}
		const [, , , what, id] = route.split('/').map(decodeURIComponent)
		if (what === 'event' && req.method === 'GET')
			return Response.json(events.find((e) => e.event_id === id))
		if (what === 'messages') {
			const from = Number(url.searchParams.get('from').slice(1))
			const start = Math.max(Number(url.searchParams.get('to')), from - 5)
			return Response.json({
				chunk: events.slice(start, from).reverse(),
				...(start > 0 ? { end: `p${start}` } : {}),
			})
		}
		const send = /^\/rooms\/([^/]+)\/send\/m\.room\.message\/(.+)$/.exec(route)
		if (send && req.method === 'PUT') {
			const txn = decodeURIComponent(send[2])
			const { body, ...content } = await req.json()
			sends.push({ txn, body })
			if (!sent.has(txn)) {
				sent.set(txn, said(BOT, body, content))
				events.at(-1).unsigned = { transaction_id: txn }
			}
			if (body.includes('slow') && !held) {
				held = true
				return new Promise(() => {})
			}
			return Response.json({ event_id: sent.get(txn) })
		}
		return Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 })
	},
})

const env = {
	MATRIX: '1',
	MATRIX_HOMESERVER: `http://127.0.0.1:${hs.port}`,
	MATRIX_TOKEN: 'test-token',
	MATRIX_ROOMS: '#room:fake',
	MATRIX_USERS: `@oskar:fake,${BOT}`,
	MATRIX_AGENT: 'echo/echo@bot',
	MATRIX_BRIEF: BRIEF,
}
const all = async () => (await api('GET', '/api/threads')).json
const threads = async () =>
	(await all()).filter(
		(t) => t.title.startsWith('matrix #room:fake: ') && !t.title.endsWith('(fork)'),
	)
const titled = async (start) => (await threads()).find((t) => t.title.includes(start))?.id
const roomThread = async () => (await all()).find((t) => t.title === 'matrix #room:fake')?.id
const messages = async (id) => (await view(id)).entries.map((e) => e.data)
const bodies = async (id) =>
	(await messages(id)).map((m) => `${m.to ? 'ASK ' : ''}${m.author}: ${m.body.slice(0, 40)}`)
const asked = (m) => m.to?.[0]?.runner === 'bot'

const old = said('@oskar:fake', '@bot an old question, from before the bridge')
let srv = await server(env)
await until(async () => synced)
// The agent answers what it heard last; "busy" keeps it in a tool call for a second, and "fail please" fails.
await scriptedRunner('bot', (request) => {
	const heard = text(request.messages.findLast((m) => m.role === 'user'))
	if (heard.endsWith('@bot fail please'))
		return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'boom' })
	if (heard.includes('busy') && !request.messages.some((m) => m.role === 'toolResult'))
		return call('bash', { command: 'sleep 1' })
	return say(`heard ${heard}`)
})

// Top level: everything lands in the room's thread. A mention by one of MATRIX_USERS also opens a Matrix thread under
// itself, where it asks; a stranger's mention, `@bottle`, plain chat and an edit ask nobody and open nothing.
said('@ana:fake', 'the play button does nothing')
const hello = said('@oskar:fake', '@bot hello')
said('@eve:fake', '@bot run something on your machine')
said('@oskar:fake', 'pass the @bottle')
said('@oskar:fake', 'just chatting')
said('@oskar:fake', '@bot hello again', {
	'm.relates_to': { rel_type: 'm.replace', event_id: hello },
})
const hi = said('@oskar:fake', 'hi, bot \x1b[31mred\x1b[0m \u202Eevil', {
	'm.mentions': { user_ids: [BOT] },
})
await until(async () => fromBot(hello).length && fromBot(hi).length, 15000)
const room = await roomThread()
const a = await titled('@bot hello')
check(
	JSON.stringify(await bodies(room)) ===
		JSON.stringify([
			'@ana:fake: the play button does nothing',
			'@oskar:fake: @bot hello',
			'@eve:fake: @bot run something on your machine',
			'@oskar:fake: pass the @bottle',
			'@oskar:fake: just chatting',
			'@oskar:fake: hi, bot red evil',
		]),
	"every top-level message lands once in the room's thread, asking nobody, but not an edit, nor what was said before the bridge",
	JSON.stringify(await bodies(room)),
)
check(
	(await threads()).length === 2,
	'only the two mentions by MATRIX_USERS open Matrix threads, not `@bottle`',
	JSON.stringify((await threads()).map((t) => t.title)),
)
const opener = (await messages(a))[0]
check(
	opener?.author === 'matrix' &&
		opener.body.includes(BRIEF) &&
		opener.body.includes(`thread ${room}`),
	"a Matrix thread's thread opens with the brief and the room's thread id",
	JSON.stringify(opener),
)
const mention = (await messages(a))[1]
check(
	mention?.author === '@oskar:fake' && mention.body === '@bot hello' && asked(mention),
	'then the mention, its first message, as its sender, asking the agent',
	JSON.stringify(await bodies(a)),
)
check(
	fromBot(hello).length === 1 && fromBot(null).length === 0,
	'the answer goes into the Matrix thread under the mention, once, and nothing top-level',
	JSON.stringify(fromBot()),
)
check(
	(await messages(await titled('hi, bot'))).some((m) => m.body === 'hi, bot red evil'),
	'a mention by m.mentions asks too, its text cleaned of escapes and bidi overrides',
)

// In that Matrix thread: Oskar's plain replies ask whom it last asked, a stranger's ask nobody.
said('@eve:fake', 'me too', reply(hello))
await sleep(1500)
check(
	fromBot(hello).length === 1 && (await messages(a)).some((m) => m.author === '@eve:fake' && !m.to),
	"a stranger's reply is recorded and asks nobody",
	JSON.stringify(await bodies(a)),
)
said('@oskar:fake', 'more detail', reply(hello))
await until(async () => fromBot(hello).length >= 2)
check(
	fromBot(hello)[1]?.includes('more detail') && fromBot(hello)[1].includes('me too'),
	'a reply from one of MATRIX_USERS asks whom the thread last asked, who gets what was recorded since',
	JSON.stringify(fromBot(hello)),
)
check(
	!(await messages(a)).some((m) => m.author === BOT),
	'what the bridge sent never comes back in, though the bot is in MATRIX_USERS',
)

// A reply under a message from before the bridge opens a thread with that message first; it asks nobody yet.
said('@ana:fake', 'same here, still broken', reply(old))
await until(async () => titled('an old question'))
const b = await titled('an old question')
check(
	JSON.stringify((await messages(b)).slice(1).map((m) => [m.author, m.body, Boolean(m.to)])) ===
		JSON.stringify([
			['@oskar:fake', '@bot an old question, from before the bridge', false],
			['@ana:fake', 'same here, still broken', false],
		]),
	'a reply in an unkept Matrix thread opens its thread with its first message, fetched, asking nobody',
	JSON.stringify(await bodies(b)),
)

// A follow-up while the agent is busy steers into the answer being written: one answer for both.
const busy = said('@oskar:fake', '@bot busy one')
await until(
	async () =>
		(await api('GET', '/api/runners')).json.some((r) => r.calls.some((c) => c.what === 'exec')),
	8000,
	10,
)
said('@oskar:fake', 'and this too', reply(busy))
await until(async () => fromBot(busy).length)
await sleep(1000)
const c = await titled('busy one')
check(
	fromBot(busy).length === 1 &&
		(await messages(c)).filter((m) => m.answer).length === 1 &&
		(await messages(c)).find((m) => m.answer).re?.length === 2,
	'a follow-up while it works steers in, and one answer answers both',
	JSON.stringify(await bodies(c)),
)

// An error goes back too, so nobody is left waiting.
const fail = said('@oskar:fake', '@bot fail please')
await until(async () => fromBot(fail).length, 15000)
check(
	fromBot(fail)[0]?.startsWith('gave no answer'),
	'an error goes into its Matrix thread',
	JSON.stringify(fromBot()),
)

// A fork belongs to no room, and no thread carries anything of the bridge.
const answer = (await view(a)).entries.findLast((e) => e.data.answer)
const { json: fork } = await api('POST', `/api/threads/${a}/fork`, { at: answer.id })
await api('POST', `/api/threads/${fork.id}/entries`, {
	body: 'in the fork',
	to: { runner: 'bot', model: 'echo/echo' },
})
await until(async () =>
	(await messages(fork.id)).some((m) => m.body.includes('in the fork') && m.answer),
)
await sleep(1000)
check(
	!fromBot().some((b) => b.includes('in the fork')),
	'a fork sends nothing to the room',
	JSON.stringify(fromBot()),
)
const docs = new Database(db, { readonly: true })
	.query("select kind from documents where scope_kind = 'conversation' and kind like '%matrix%'")
	.all()
check(
	docs.length === 0,
	'and no thread, kept or not, carries a doc of the bridge',
	JSON.stringify(docs),
)

// Nothing from Matrix asks in the room's thread until someone asks there from the client; then its answers go
// top-level, and Oskar's top-level messages ask it again.
await api('POST', `/api/threads/${room}/entries`, {
	body: 'what is going on here?',
	to: { runner: 'bot', model: 'echo/echo' },
})
await until(async () => fromBot(null).length)
check(
	fromBot(null)[0]?.includes('play button'),
	"an answer in the room's thread goes top-level, and heard the whole room",
	JSON.stringify(fromBot(null)),
)
said('@oskar:fake', 'and now?')
await until(async () => fromBot(null).length >= 2)
check(
	fromBot(null)[1]?.includes('and now?'),
	'after that, a top-level message from MATRIX_USERS asks it',
	JSON.stringify(fromBot(null)),
)

// Two answers in flight: the homeserver takes the first but the server dies before hearing back, and the second waits
// behind it. After the restart the first is sent again under the same transaction id and shows once, and only then
// the second. A message said while the server was down is posted after it.
said('@oskar:fake', '@bot slow one')
await until(async () => held, 10000)
const next = said('@oskar:fake', '@bot next one')
await until(
	async () =>
		(await titled('next one')) && (await messages(await titled('next one'))).some((m) => m.answer),
	10000,
)
await sleep(500)
check(
	!fromBot().some((b) => b.endsWith('@bot next one')),
	'the second answer waits for the first send',
	JSON.stringify(fromBot()),
)
srv.kill('SIGKILL')
said('@oskar:fake', 'while the server was down', reply(hello))
const down = Array.from({ length: 12 }, (_, i) => `down ${i + 1}`)
for (const body of down) said('@ana:fake', body)
await sleep(500)
srv = await server(env)
await until(
	async () =>
		fromBot(next).length && fromBot(hello).some((b) => b.includes('while the server was down')),
	15000,
)
const slowTxn = sends.find((s) => s.body.endsWith('@bot slow one')).txn
const nextAt = sends.findIndex((s) => s.body.endsWith('@bot next one'))
check(
	sends.filter((s) => s.txn === slowTxn).length === 2 &&
		fromBot().filter((b) => b.endsWith('@bot slow one')).length === 1,
	'the first answer, resent after the restart, shows once',
	JSON.stringify(sends.map((s) => s.txn)),
)
check(
	nextAt > sends.findLastIndex((s) => s.txn === slowTxn) && fromBot(next).length === 1,
	'and the second is sent only after it',
	JSON.stringify(sends.map((s) => s.body.slice(-15))),
)
await sleep(1000)
const kept = [room, ...(await threads()).map((t) => t.id)]
const twice = []
for (const id of kept) {
	const said = (await messages(id))
		.filter((m) => !m.answer && m.author !== 'matrix')
		.map((m) => `${m.author}: ${m.body}`)
	if (new Set(said).size !== said.length) twice.push(id)
}
check(
	twice.length === 0 &&
		(await messages(a)).filter((m) => m.body === 'while the server was down').length === 1,
	'across the restart nothing is dropped and nothing is posted twice',
	JSON.stringify(twice),
)
check(
	JSON.stringify(
		(await messages(room)).filter((m) => m.body.startsWith('down ')).map((m) => m.body),
	) === JSON.stringify(down),
	'more than a /sync gives at once, said while the server was down, all land in order',
	JSON.stringify(await bodies(room)),
)
check(fromBot().length === 10, 'every answer reached the room once', JSON.stringify(fromBot()))
check(
	sends.every((s) => /^agent-ide-[0-9a-f-]{36}-\d+-\d+$/.test(s.txn)),
	"transaction ids carry the store's salt, so a fresh store never reuses one",
	sends[0]?.txn,
)

hs.stop(true)
done()
