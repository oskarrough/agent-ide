/** MODULES=+director with picks: a message for the whole group asks each bot the director picks, one after another, each handed the answers before it */
import { answered, api, check, done, say, scriptedRunner, server, text, view } from './lib.js'

await server({ MODULES: '+bots,+director', DIRECTOR_MODEL: 'echo/echo@laptop' })
const handed = {}
await scriptedRunner('laptop', (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	const last = request.messages.at(-1)
	if (system.startsWith('You choose who answers')) {
		const message = text(last).match(/New message: \[[^\]]+\] (.*)/)?.[1] ?? ''
		if (message.includes('all think')) return say('Kira, @Ada, Nobody-here: both have a view')
		return say('Kira: she knows roses')
	}
	const name = /You are the bot (\w+)/.exec(JSON.stringify(request.messages))?.[1]
	;(handed[name] ??= []).push(text(last))
	return say(`${name} thinks so`)
})
await api('POST', '/api/bots', {
	name: 'Kira',
	to: 'echo/echo@laptop',
	instructions: 'A gardener.',
})
await api('POST', '/api/bots', { name: 'Ada', to: 'echo/echo@laptop' })

const garden = (await api('POST', '/api/threads', { title: 'garden' })).json.id
await api('POST', `/api/threads/${garden}/entries`, { body: 'hello', to: ['Ada', 'Kira'] })
await answered(garden, 2)
await api('POST', `/api/threads/${garden}/entries`, { body: 'what do you all think?' })
const after = await answered(garden, 4)
const asked = after.entries.at(-3)
check(
	JSON.stringify(asked.data.to) === '["Kira","Ada"]' && asked.data.picked === 'both have a view',
	'a message for the group asks each bot the director picks, in its order; a name not here is dropped',
	JSON.stringify(asked.data),
)
check(
	JSON.stringify(after.entries.slice(-2).map((entry) => entry.data.author)) === '["Kira","Ada"]',
	'they answer in that order',
)
check(
	handed.Ada.at(-1).includes('<message from="Kira" agent>\nKira thinks so\n</message>'),
	'the second is handed the first one’s answer',
	handed.Ada.at(-1),
)

await api('DELETE', '/api/bots/Kira')
await api('DELETE', '/api/bots/Ada')
done()
