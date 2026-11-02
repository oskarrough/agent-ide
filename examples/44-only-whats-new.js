// A runner keeps the conversation it last streamed for each agent, so the next model request sends only what's new.
// A runner that reconnects starts with nothing, so it gets the whole conversation again; the model sees it all either way.
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { messageText, serveRunner } from '../remote.js'
import { answered, answers, api, base, check, done, keyFor, server, until, view } from './lib.js'

await server()
const key = await keyFor('laptop')
// What each stream request carried, and whether the model saw the first message.
const seen = []
const online = (on) =>
	until(() =>
		api('GET', '/api/runners').then((r) =>
			r.json.some((x) => x.name === 'laptop' && x.online === on),
		),
	)

function start() {
	const script = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] })
	script.setResponses(
		Array.from({ length: 20 }, () => (ctx) => {
			seen.at(-1).first = ctx.messages.some((m) => messageText(m).includes('first'))
			return fauxAssistantMessage([fauxText('ok')])
		}),
	)
	const models = createModels()
	models.setProvider(script.provider)
	const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?runner=laptop&dir=/tmp`, {
		headers: { authorization: `Bearer ${key}` },
	})
	const runner = serveRunner({
		name: 'laptop',
		dir: '/tmp',
		models,
		resolve: () => ({ model: script.getModel() }),
		echo: script,
		send: (t) => socket.readyState === WebSocket.OPEN && socket.send(t),
	})
	socket.onmessage = ({ data }) => {
		const m = JSON.parse(data)
		if (m.op === 'stream')
			seen.push({ since: m.context.since ?? 0, sent: m.context.messages.length })
		runner.receive(data)
	}
	return socket
}

let socket = start()
await online(true)
const { id } = (await api('POST', '/api/threads', { title: 'deltas' })).json
const ask = async (body, n) => {
	await api('POST', `/api/threads/${id}/entries`, {
		body,
		to: { runner: 'laptop', model: 'scripted/model' },
	})
	return answered(id, n)
}

await ask('the first message', 1)
check(seen[0]?.since === 0, 'the first request sends the whole conversation', JSON.stringify(seen))
await ask('the second', 2)
const second = seen[1]
check(
	second?.since === seen[0].sent && second.sent === 2,
	'the next sends only what came after it: the answer and the new message',
	JSON.stringify(seen),
)
check(second?.first === true, 'and the model still sees all of it')

socket.close()
await online(false)
socket = start()
await online(true)
const before = seen.length
await ask('the third', 3)
const after = seen.slice(before)
check(
	after.length === 1 && after[0].since === 0 && after[0].sent === 6,
	'a reconnected runner gets everything, in one request',
	JSON.stringify(after),
)
check(after[0]?.first === true, 'so the model sees all of it there too')
check(answers(await view(id)).length === 3, 'and every message is answered once')

socket.close()
done()
