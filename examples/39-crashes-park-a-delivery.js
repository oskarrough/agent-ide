// A delivery that crash after crash cut off is parked by Pi, and the thread says so instead of working forever.
// Retrying it delivers the message once the runner is back.
import { answered, api, check, done, runner, server, sleep, until, view } from './lib.js'

let srv = await server()
let laptop = await runner('laptop')
const to = { runner: 'laptop', model: 'echo/echo' }
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'parked' })
await api('POST', `/api/threads/${id}/entries`, { body: 'hi', to })
await answered(id)
laptop.kill()
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)))
await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to })
for (let i = 0; i < 6; i++) {
	srv.kill('SIGKILL')
	await sleep(300)
	srv = await server()
	await sleep(300)
}
const v = await view(id)
check(
	v.status === 'parked' && v.agents[0]?.status === 'parked',
	'the thread and its agent say the delivery is parked',
	`${v.status} ${v.agents[0]?.status}`,
)
laptop = await runner('laptop')
await sleep(500)
check((await view(id)).status === 'parked', 'a parked delivery stays put when the runner returns')
const { json } = await api('POST', `/api/threads/${id}/retry`)
check(json.retried?.length === 1, 'retry runs the parked delivery', JSON.stringify(json))
const after = await answered(id, 2)
check(
	after?.entries.filter((e) => e.data.answer).length === 2,
	'and the message is answered once',
	after?.status,
)
done()
