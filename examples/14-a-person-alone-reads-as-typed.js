/** While one person is all an agent has heard, it reads their words as typed; once someone else speaks, it reads who wrote each, for good */
import { answered, api, check, conversationOf, done, runner, server, text } from './lib.js'

await server()
await runner('laptop')

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'as typed' })
const to = { runner: 'laptop', model: 'echo/echo' }
const handed = async (count) => {
	const view = await answered(id, count)
	const own = await conversationOf(view, 'echo/echo@laptop')
	return own.entries.filter((e) => e.kind === 'agent-ide.delivery').map((e) => text(e.model[0]))
}

const typed = 'fix this:\n```js\nif (a) {\n\treturn b\n}\n```\nthanks'
await api('POST', `/api/threads/${id}/entries`, { body: typed, to })
const [first] = await handed(1)
check(first === typed, 'one person alone: the agent reads exactly what they typed', first)

await api('POST', `/api/threads/${id}/entries`, { body: 'me too', to }, 'ana')
await api('POST', `/api/threads/${id}/entries`, { body: 'and again', to })
const [, second, third] = await handed(3)
check(
	second === 'ana: me too' && third === 'oskar: and again',
	'once a second person speaks, every turn says who wrote it, even when only the first speaks again',
	JSON.stringify([second, third]),
)

done()
