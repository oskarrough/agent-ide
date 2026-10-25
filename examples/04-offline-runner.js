// A runner that goes away. A thread waiting for it is blocked, not failed; stopping it leaves it idle, with no error.
// Pi on the runner resolves models, so an offline runner takes only a model it has run before.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { answered, api, check, dir, done, runner, server, sleep, until, view } from './lib.js'

await server()
// The models pi has enabled in the runner's folder are offered, and what it can't resolve is skipped.
mkdirSync(path.join(dir, '.pi'))
writeFileSync(
	path.join(dir, '.pi', 'settings.json'),
	JSON.stringify({ enabledModels: ['echo/e*', 'claude-bridge/claude-opus-5-5'] }),
)
const away = await runner('away')
const offered = (await api('GET', '/api/runners')).json.find((x) => x.name === 'away')
check(
	JSON.stringify(offered?.offers) === '["echo/echo"]' && !offered.models.includes('echo/echo'),
	'a runner offers the models enabled in pi, unresolved',
	JSON.stringify(offered),
)
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'away' })
await api('POST', `/api/threads/${id}/entries`, {
	body: 'hi',
	to: { runner: 'away', model: 'echo/echo' },
})
await answered(id)
await api('POST', `/api/threads/${id}/read`, {})
away.kill()
await until(() =>
	api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === 'away' && !x.online)),
)

const unknown = await api('POST', `/api/threads/${id}/entries`, {
	body: 'anyone?',
	to: { runner: 'away', model: 'echo' },
})
check(
	unknown.status === 400 && /offline/.test(unknown.json.error),
	"an offline runner can't resolve a model it hasn't run",
	JSON.stringify(unknown),
)
await api('POST', `/api/threads/${id}/entries`, {
	body: 'anyone?',
	to: { runner: 'away', model: 'echo/echo' },
})
const blocked = await until(async () => (await view(id)).status === 'blocked')
check(Boolean(blocked), 'a thread waiting for an offline runner is blocked')

await api('POST', `/api/threads/${id}/stop`, {})
await sleep(800)
const stopped = await view(id)
check(
	stopped.status === 'idle' && !stopped.entries.some((e) => e.data.error),
	'a stopped thread is idle, with no error entry',
	`${stopped.status} ${JSON.stringify(stopped.entries)}`,
)

done()
