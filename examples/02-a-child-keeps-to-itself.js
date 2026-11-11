/** A child thread keeps what's said in it */
import {
	api,
	check,
	conversationOf,
	done,
	quiet,
	runner,
	say,
	scriptedRunner,
	server,
	settled,
	until,
	view,
} from './lib.js'

await server()
await runner('laptop')

const {
	json: { id: parent },
} = await api('POST', '/api/threads', { title: 'parent' })
const { json: child } = await api('POST', '/api/threads', { title: 'child', parent })
await api('POST', `/api/threads/${child.id}/entries`, {
	body: 'do it',
	to: { runner: 'laptop', model: 'echo/echo' },
})
const answer = await until(async () => (await view(child.id)).entries.find((e) => e.data.answer))
check(
	answer?.data.body.startsWith('echo@laptop heard: do it'),
	'the child answers in the child',
	JSON.stringify(answer),
)
await quiet()
check(
	(await view(parent)).entries.length === 0,
	'and its parent hears nothing of it',
	JSON.stringify((await view(parent)).entries),
)

/** Stopped mid-answer: the input was placed, then aborted */
const slow = await scriptedRunner('slow', () => say(`thinking ${'slowly '.repeat(300)}`))
const { json: stopped } = await api('POST', '/api/threads', { title: 'stopped', parent })
await api('POST', `/api/threads/${stopped.id}/entries`, {
	body: 'take your time',
	to: { runner: 'slow', model: 'echo/echo' },
})
const placed = await until(
	async () =>
		(await conversationOf(await view(stopped.id), 'echo/echo@slow')).entries?.some(
			(e) => e.kind === 'agent-ide.delivery',
		),
	8000,
	20,
)
await api('POST', `/api/threads/${stopped.id}/stop`, {})
const after = await settled(stopped.id)
check(
	Boolean(placed) && Boolean(after) && after.entries.every((e) => e.data.author === 'oskar'),
	'a stopped child posts nothing in its thread',
	JSON.stringify(after?.entries),
)
check((await view(parent)).entries.length === 0, 'nor its parent')

slow.close()
done()
