// Retries never double. A client that lost a response posts again with the same requestId and gets the first result:
// one thread, one message, one answer, one command, even when the server restarted between the two posts. A request
// id used for another command is refused.
import { answered, answers, api, check, done, runner, server, sleep, until, view } from './lib.js'

let srv = await server()
await runner('laptop')
const to = { runner: 'laptop', model: 'echo/echo' }
const threads = async () => (await api('GET', '/api/threads')).json

const made = await api('POST', '/api/threads', { title: 'once', requestId: 'make-1' })
const again = await api('POST', '/api/threads', { title: 'once', requestId: 'make-1' })
check(
	made.status === 201 && again.json.id === made.json.id && (await threads()).length === 1,
	'a retried thread is the same thread',
	JSON.stringify([made, again]),
)
const id = made.json.id

const said = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	requestId: 'say-1',
})
const resent = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	requestId: 'say-1',
})
check(
	JSON.stringify(resent.json) === JSON.stringify(said.json),
	'a retried message returns the first result',
	JSON.stringify([said.json, resent.json]),
)
await answered(id)

srv.kill('SIGKILL')
await sleep(500)
srv = await server()
const later = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	requestId: 'say-1',
})
const remade = await api('POST', '/api/threads', { title: 'once', requestId: 'make-1' })
check(
	JSON.stringify(later.json) === JSON.stringify(said.json) && remade.json.id === id,
	'a retry after a restart still finds its receipt',
	JSON.stringify([later.json, remade.json]),
)

const ran = await api('POST', `/api/threads/${id}/entries`, {
	body: '$ echo hi',
	requestId: 'run-1',
})
await api('POST', `/api/threads/${id}/entries`, { body: '$ echo hi', requestId: 'run-1' })
await until(async () => (await view(id)).entries.some((e) => e.data.shell))
await sleep(500)
const v = await view(id)
check(
	ran.status === 201 &&
		v.entries.filter((e) => e.data.author === 'oskar' && e.data.body === 'hello').length === 1,
	'one message',
)
check(answers(v).length === 1, 'one answer', JSON.stringify(answers(v).length))
check(v.entries.filter((e) => e.data.shell).length === 1, 'one command run')
check((await threads()).length === 1, 'one thread')

const other = await api('POST', '/api/threads', { title: 'other', requestId: 'say-1' })
const wrong = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	requestId: 'make-1',
})
check(
	other.status === 400 && wrong.status === 400 && (await threads()).length === 1,
	'a request id for another command is refused',
	JSON.stringify([other.json, wrong.json]),
)

done()
