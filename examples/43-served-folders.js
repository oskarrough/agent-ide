// A runner serves several folders: every --dir, and with --discover-dirs the checkouts beneath them. Work runs in
// any of them and nowhere else, and the runner says how many threads it's busy in.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answered, answers, api, check, dir, done, runner, server, until, view } from './lib.js'

const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agent-ide-other-')))
for (const d of ['app/.git', 'org/lib/.jj', 'org/deep/er/.git', 'node_modules/x/.git', '.hidden/.git'])
	mkdirSync(path.join(dir, d), { recursive: true })

await server()
await runner('laptop', { args: ['--dir', other, '--discover-dirs'] })
const listed = (await api('GET', '/api/runners')).json.find((r) => r.name === 'laptop')
const home = listed?.dir
check(
	JSON.stringify(listed?.folders) ===
		JSON.stringify([home, other, path.join(home, 'app'), path.join(home, 'org/lib')]),
	'a runner lists its folders, then the checkouts two levels beneath them',
	JSON.stringify(listed?.folders),
)

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'folders' })
const run = async (command, at) => {
	const before = (await view(id)).entries.filter((e) => e.data.shell).length
	const res = await api('POST', `/api/threads/${id}/entries`, {
		body: `$ ${command}`,
		to: { runner: 'laptop', ...(at === undefined ? {} : { dir: at }) },
	})
	if (res.status >= 300) return res
	return until(async () => (await view(id)).entries.filter((e) => e.data.shell)[before]?.data.shell)
}
check((await run('pwd'))?.stdout === `${home}\n`, 'no dir is its first folder')
check((await run('pwd', other))?.stdout === `${other}\n`, 'another --dir is reached by its path')
check((await run('pwd', 'app'))?.stdout === `${home}/app\n`, 'a checkout, relative to the first')
const outside = await run('pwd', os.tmpdir())
check(
	outside.status === 400 && /outside laptop's folders/.test(outside.json.error),
	'a folder it does not serve is refused',
	JSON.stringify(outside),
)

await api('POST', `/api/threads/${id}/entries`, {
	body: 'hi there',
	to: { runner: 'laptop', model: 'echo/echo', dir: other },
})
const there = await answered(id)
check(
	there?.agents[0]?.to.dir === other && answers(there).length === 1,
	'an agent works in another folder, and says which',
	JSON.stringify(there?.agents),
)

await api('POST', `/api/threads/${id}/entries`, { body: '$ sleep 2', to: { runner: 'laptop' } })
const busy = await until(async () =>
	(await api('GET', '/api/runners')).json.find((r) => r.name === 'laptop' && r.busy === 1),
)
check(Boolean(busy), 'while a command runs, the runner is busy in one thread')
const idle = await until(
	async () => (await api('GET', '/api/runners')).json.find((r) => r.name === 'laptop' && r.busy === 0),
	5000,
)
check(Boolean(idle), 'and then in none')

done()
