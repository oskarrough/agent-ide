// A `$ cmd` runs on a runner with no model at all.
import { api, check, done, runner, server, until, view } from './lib.js'

await server()
await runner('laptop')
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'commands' })
// The runner's pi has no logins here, so it has no default model.
await api('POST', `/api/threads/${id}/entries`, { body: '$ echo hi', to: { runner: 'laptop' } })
const echoed = await until(async () => (await view(id)).entries.find((e) => e.data.shell))
check(
	echoed?.data.shell.stdout === 'hi\n',
	'a command needs no model',
	JSON.stringify(echoed?.data),
)

done()
