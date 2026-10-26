// A runner dials in with its own key, so nobody can take its name, and a revoked one goes offline and stays out.
import { api, base, check, done, runner, server, sleep, until } from './lib.js'

await server()
const online = async (name) =>
	(await api('GET', '/api/runners')).json.find((r) => r.name === name)?.online
const exited = (p) => new Promise((resolve) => p.on('exit', (code) => resolve(code)))
// What the server says to a socket that claims `name`, with this key.
const dial = (name, key) =>
	new Promise((resolve) => {
		const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?runner=${name}&dir=/`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
		})
		socket.onclose = ({ code, reason }) => resolve({ code, reason })
	})

const nokey = await runner('stray', { env: { AGENT_IDE_KEY: '' }, wait: false })
const out = []
nokey.stdout.on('data', (d) => out.push(String(d)))
check((await exited(nokey)) === 1, 'a runner without a key is turned away, and stops')
check(
	out.join('').includes('bun cli.js key stray'),
	'and is told how to get one',
	JSON.stringify(out),
)

const laptop = await runner('laptop')
check(await online('laptop'), 'a runner with its key is online')
const thief = await dial('laptop', 'air_guessed')
check(thief.code === 4001, 'a wrong key is turned away', JSON.stringify(thief))
await sleep(200)
check(await online('laptop'), 'and the real laptop stays online: nobody can take its name')

const minted = await api('POST', '/api/runners', { name: '../x' })
check(minted.status === 400, 'a runner name is letters, digits, dot, dash or underscore')

const gone = exited(laptop)
check((await api('DELETE', '/api/runners/laptop')).status === 200, 'revoking answers')
check((await gone) === 1, 'the revoked runner is cut off and stops dialling back')
check(!(await until(() => online('laptop'), 1000)), 'and it stays offline')

done()
