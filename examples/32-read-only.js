// A runner started with --read-only lends its folder to read: an agent there reads, but its writes and commands
// come back as tool errors, and so does a `$ cmd`. Nothing in the folder changes.
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { answered, api, call, check, dir, done, say, scriptedRunner, server, text } from './lib.js'

writeFileSync(path.join(dir, 'notes.txt'), 'the plans are in the drawer')
// Each message names one tool call; the agent answers with what the tool said.
const route = (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(`tool said: ${text(last)}`)
	const asked = text(last)
	if (asked.includes('read')) return call('read', { path: 'notes.txt' })
	if (asked.includes('write')) return call('write', { path: 'new.txt', content: 'hello' })
	return call('bash', { command: 'touch ran.txt' })
}

await server()
await scriptedRunner('reader', route, { readOnly: true })
const runner = (await api('GET', '/api/runners')).json.find((r) => r.name === 'reader')
check(runner?.readOnly === true, 'the server knows the runner is read-only')

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'read only' })
const ask = async (body, n) => {
	await api('POST', `/api/threads/${id}/entries`, {
		body,
		to: { runner: 'reader', model: 'echo/echo' },
	})
	return (await answered(id, n))?.entries.at(-1).data.body ?? ''
}
const read = await ask('please read', 1)
check(read.includes('the plans are in the drawer'), 'reading works', read)
const wrote = await ask('please write', 2)
check(
	wrote.includes('read-only') && !existsSync(path.join(dir, 'new.txt')),
	'a write is refused as a tool error, and no file appears',
	wrote,
)
const ran = await ask('please run', 3)
check(ran.includes('read-only') && !existsSync(path.join(dir, 'ran.txt')), 'so is a command', ran)

await api('POST', `/api/threads/${id}/entries`, {
	body: '$ touch typed.txt',
	to: { runner: 'reader', model: 'echo/echo' },
})
const shell = await answered(id, 3).then(async () => {
	for (let i = 0; i < 50; i++) {
		const e = (await api('GET', `/api/threads/${id}`)).json.entries.find((e) => e.data.shell)
		if (e) return e.data.shell
		await new Promise((r) => setTimeout(r, 100))
	}
})
check(
	shell?.error?.includes('read-only') && !existsSync(path.join(dir, 'typed.txt')),
	'and a `$ cmd` someone types',
	JSON.stringify(shell),
)
done()
