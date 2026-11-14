/** One person's words reach an agent as typed, however many bots speak; a bot's come inside a tag that names it, and so do people's once a second person writes */
import { answered, api, check, done, say, scriptedRunner, server, text } from './lib.js'

await server({ MODULES: '+bots' })
/** What each bot was handed, by name */
const handed = {}
await scriptedRunner('laptop', (request) => {
	const system = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const name = /You are (\w+) in thread/.exec(system)?.[1]
	;(handed[name] ??= []).push(text(request.messages.at(-1)))
	return say(`${name} here`)
})
for (const name of ['Ada', 'Bram']) await api('POST', '/api/bots', { name, to: 'echo/echo@laptop' })
const { id } = (await api('POST', '/api/threads', { title: 'as typed' })).json
const post = (body, to, user) => api('POST', `/api/threads/${id}/entries`, { body, to }, user)

const typed = 'fix this:\n```js\nif (a) {\n\treturn b\n}\n```\nthanks'
await post(typed, ['Ada'])
await answered(id, 1)
check(handed.Ada[0] === typed, 'the agent reads exactly what the person typed', handed.Ada[0])

await post('and you, Bram?', ['Bram'])
await answered(id, 2)
await post('Ada again', ['Ada'])
await answered(id, 3)
check(
	handed.Ada[1] ===
		'and you, Bram?\n\n<message from="Bram" agent>\nBram here\n</message>\n\nAda again',
	"after a bot has spoken the person's words still come as typed, and the bot's inside a tag that names it",
	handed.Ada[1],
)

await post('me too', ['Ada'], 'ana')
await answered(id, 4)
await post('and again', ['Ada'])
await answered(id, 5)
check(
	handed.Ada[2] ===
		'[Every message above without a tag is oskar\'s.]\n\n<message from="ana">\nme too\n</message>' &&
		handed.Ada[3] === '<message from="oskar">\nand again\n</message>',
	'once a second person writes, each person is named, and the agent hears once whose the untagged words were',
	JSON.stringify(handed.Ada.slice(2)),
)

done()
