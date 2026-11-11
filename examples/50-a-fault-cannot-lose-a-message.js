/** Kill the server after an admission fault is durable, before any failure report can run. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	conversationOf,
	dir,
	done,
	say,
	scriptedRunner,
	server,
	text,
	view,
} from './lib.js'

const module = path.join(dir, 'fault-window.js')
writeFileSync(
	module,
	`export function server() {
	const error = console.error
	console.error = (...args) => {
		error(...args)
		if (String(args[0]).includes('pi-durable: task_faulted:')) process.kill(process.pid, 'SIGKILL')
	}
	return { catchUp: async (_thread, held) => {
		if (held.some(e => e.data.body === 'first')) {
			await new Promise(r => setTimeout(r, 300))
			throw new Error('injected input failure')
		}
		return held.map(e => e.data.body).join('\\n')
	} }
}`,
)
const srv = await server({ MODULES: module })
await scriptedRunner('bot', () => say('answered'))
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'durable failure' })
const exited = new Promise((resolve) => srv.once('exit', resolve))
for (const body of ['first', 'second'])
	await api('POST', `/api/threads/${id}/entries`, { body, to: 'echo/echo@bot' })
await exited
await server({ MODULES: 'talk' })
check(Boolean(await answered(id)), 'the next accepted delivery resumes after the crash')
const v = await view(id)
const c = await conversationOf(v, 'echo/echo@bot')
const inputs = c.entries.filter((e) => e.kind === 'agent-ide.delivery').map((e) => text(e.model[0]))
check(
	inputs.length === 1 && inputs[0].includes('first\n\nsecond'),
	'it takes the undelivered message too, once and in thread order',
	JSON.stringify(inputs),
)
check(v.entries.filter((e) => e.data.error).length === 1, 'the fault is reported once')
done()
