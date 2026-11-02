// A delivery that crash after crash cut off ends instead of running forever, and the thread says so: the agent gave no
// answer, and its message waits, unseen, for the next ask. Stops aren't crashes: as many as you like cut nothing off.
import { answered, api, check, done, runner, server, sleep, until, view } from './lib.js'

let srv = await server()
let laptop = await runner('laptop')
const to = { runner: 'laptop', model: 'echo/echo' }
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'crashes' })
await api('POST', `/api/threads/${id}/entries`, { body: 'hi', to })
await answered(id)
laptop.kill()
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)))
await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to })
const stopped = (p) => new Promise((resolve) => p.once('exit', (code) => resolve(code)))
for (let i = 0; i < 6; i++) {
	const exit = stopped(srv)
	srv.kill('SIGTERM')
	if ((await exit) !== 0) check(false, 'a stop closes the server cleanly', `exit ${await exit}`)
	srv = await server()
}
check(
	(await view(id)).agents[0]?.status === 'blocked',
	'six stops later, the delivery still waits for its runner',
	(await view(id)).agents[0]?.status,
)
for (let i = 0; i < 6; i++) {
	srv.kill('SIGKILL')
	await sleep(300)
	srv = await server()
	await sleep(300)
}
const v = await until(async () => {
	const v = await view(id)
	return v.status === 'error' && v
})
check(
	v?.entries.at(-1)?.data.error && v.entries.at(-1).data.body.includes('restart_limit'),
	'the thread says the agent gave no answer, and why',
	JSON.stringify(v?.entries.at(-1)?.data),
)
check(
	v?.agents[0]?.status === 'idle',
	'and the agent is idle, not working forever',
	v?.agents[0]?.status,
)
laptop = await runner('laptop')
await sleep(500)
check((await view(id)).entries.length === v?.entries.length, 'nothing runs again on its own')
await api('POST', `/api/threads/${id}/entries`, { body: 'again', to })
const after = await answered(id, 2)
const answer = after?.entries.filter((e) => e.data.answer).at(-1)
check(Boolean(answer), 'the next ask is answered', after?.status)
check(
	JSON.stringify(answer?.data.re) ===
		JSON.stringify(
			after?.entries.filter((e) => ['hello', 'again'].includes(e.data.body)).map((e) => e.id),
		),
	'and the answer takes the message that waited too',
	JSON.stringify(answer?.data),
)
done()
