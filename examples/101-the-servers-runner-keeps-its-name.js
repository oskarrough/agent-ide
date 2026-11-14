/** The server's own runner keeps the name it first got, so a machine renamed by its network stays one runner */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answered, api, check, dir, done, kill, server, until } from './lib.js'

/** macOS renames itself when the network changes; this stands in for that */
const named = (hostname) => ({
	NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`import os from 'node:os';os.hostname=()=>'${hostname}'`)}`,
})
const HOME = mkdtempSync(path.join(os.tmpdir(), 'agent-ide-home-'))
const rows = async () => (await api('GET', '/api/runners')).json
const online = async (name) => (await rows()).find((row) => row.name === name)?.online

let srv = await server({ RUNNER: dir, HOME, ...named('mac') })
check(Boolean(await until(() => online('mac'))), 'the server lends this machine as mac')
const { id } = (await api('POST', '/api/threads', { title: 'renamed' })).json
const post = (body) =>
	api('POST', `/api/threads/${id}/entries`, { body, to: { runner: 'mac', model: 'echo/echo' } })
await post('hello')
check(Boolean(await answered(id)), 'an agent on it answers')

await kill(srv)
srv = await server({ RUNNER: dir, HOME, ...named('mac.local') })
check(
	Boolean(await until(() => online('mac'))),
	'after the machine is renamed it comes back as mac',
	JSON.stringify(await rows()),
)
check(
	(await rows()).every((row) => row.name !== 'mac.local'),
	'and no second runner appears for the same machine',
)
check(
	(await rows()).find((row) => row.name === 'mac')?.own,
	'the page still knows it is the server’s own',
)
await post('still there?')
check(Boolean(await answered(id, 2)), 'so its agents carry on')
done()
