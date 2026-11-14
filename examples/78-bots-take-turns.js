/** MODULES=+director: two bots a message asks answer one after another, in the order named, each handed the answers before it */
import {
	answered,
	api,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server({ MODULES: '+bots,+director' })
/** What each bot was handed, by name */
const handed = {}
await scriptedRunner('laptop', (request) => {
	const system = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const name = /You are (\w+) in thread/.exec(system)?.[1]
	const last = request.messages.at(-1)
	if (last.role === 'toolResult') return say(`${name} done`)
	const told = text(last)
	;(handed[name] ??= []).push(told)
	if (told.includes('slow')) return call('bash', { command: 'sleep 0.5' })
	return say(`${name} here`)
})
const post = (id, body, to) =>
	api('POST', `/api/threads/${id}/entries`, { body, ...(to !== undefined ? { to } : {}) })
const authors = (v) => v.entries.filter((e) => e.data.answer).map((e) => e.data.author)

for (const name of ['Ada', 'Bram']) await api('POST', '/api/bots', { name, to: 'echo/echo@laptop' })

const both = (await api('POST', '/api/threads', { title: 'both' })).json.id
await post(both, 'hi both', ['Bram', 'Ada'])
const first = await answered(both, 2)
check(
	JSON.stringify(authors(first)) === '["Bram","Ada"]',
	'they answer in the order named',
	JSON.stringify(authors(first)),
)
check(
	handed.Ada?.[0]?.includes('<message from="Bram" agent>\nBram here\n</message>'),
	'the second is handed the first one’s answer',
	JSON.stringify(handed.Ada),
)
check(
	JSON.stringify(first.entries[0].data.to) === '["Bram","Ada"]' &&
		first.entries.slice(1).every((e) => JSON.stringify(e.data.re) === `[${first.entries[0].id}]`),
	'the message keeps its `to`, and each answer says what it answers',
	JSON.stringify(first.entries.map((e) => e.data)),
)

const mentioned = (await api('POST', '/api/threads', { title: 'mentioned' })).json.id
await post(mentioned, 'hello', ['Ada', 'Bram'])
await answered(mentioned, 2)
await post(mentioned, '@bram slow please, then @ada')
await until(async () => (await view(mentioned)).status === 'working')
await post(mentioned, 'and one more thing', null)
const second = await answered(mentioned, 4)
check(
	JSON.stringify(authors(second).slice(2)) === '["Bram","Ada"]',
	'@mentions take turns in the order written',
	JSON.stringify(authors(second)),
)
const told = handed.Ada.at(-1)
check(
	told.includes('<message from="Bram" agent>\nBram done\n</message>') &&
		told.includes('and one more thing'),
	'a message written mid-sequence reaches the next bot along with the answer before it',
	told,
)

const stopped = (await api('POST', '/api/threads', { title: 'stopped' })).json.id
await post(stopped, 'slow, both', ['Bram', 'Ada'])
await until(async () => (await view(stopped)).status === 'working')
const asked = handed.Ada.length
await api('POST', `/api/threads/${stopped}/stop`)
const after = await until(async () => {
	const v = await view(stopped)
	return v.status === 'idle' ? v : null
})
check(
	after && !authors(after).length && handed.Ada.length === asked,
	'stop ends the whole sequence: the bot waiting its turn is never asked',
	JSON.stringify(after?.entries.map((e) => e.data)),
)

for (const name of ['Ada', 'Bram']) await api('DELETE', `/api/bots/${name}`)
done()
