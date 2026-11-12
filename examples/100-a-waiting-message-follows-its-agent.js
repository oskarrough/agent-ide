/** A message waiting for an offline runner goes with its agent when the agent is asked on another runner */
import {
	answered,
	answers,
	api,
	check,
	done,
	say,
	scriptedRunner,
	server,
	until,
	view,
} from './lib.js'

await server()
const away = await scriptedRunner('away', () => say('from away'))
await scriptedRunner('here', () => say('from here'))
const id = (await api('POST', '/api/threads', { title: 'moved' })).json.id
const post = (body, to) => api('POST', `/api/threads/${id}/entries`, { body, to })

await post('hi', { runner: 'away', model: 'echo/echo' })
await answered(id)
away.close()
await until(() =>
	api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === 'away' && !x.online)),
)
await post('still there?', { runner: 'away', model: 'echo/echo' })
check(
	Boolean(await until(async () => (await view(id)).status === 'blocked')),
	'a message to an offline runner waits for it',
)

await post('then over here', { runner: 'here', model: 'echo/echo' })
const thread = await answered(id, 2)
const last = thread && answers(thread).at(-1)
check(
	last?.data.body === 'from here',
	'once the agent moves, what waited goes with it and is answered on its new runner',
	JSON.stringify(thread && [thread.status, answers(thread).map((e) => e.data.body)]),
)
done()
