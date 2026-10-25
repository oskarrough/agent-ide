// Runners with owners. laptop takes work from oskar and from the agents on desktop; desktop also takes Ana.
// A refusal writes nothing, says who the runner takes work from, and holds while the runner is offline.
// The hop is honest: Ana reaches laptop through an agent on desktop, and an agent on Ana's own runner doesn't.
import {
	answered,
	answers,
	api,
	brief,
	call,
	check,
	conversationOf,
	done,
	runner,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()
const laptop = await runner('laptop', { args: ['--owner', 'oskar', '--allow', '@desktop'] })
const route = (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say(`tool said: ${t}`)
	if (t.includes('answering from thread')) return say('noted')
	if (t.includes('reach laptop'))
		return call('post', { title: 'hop', body: 'hello laptop', to: 'echo/echo@laptop' })
	return say(`heard: ${t}`)
}
const desktop = await scriptedRunner('desktop', route, {
	query: [
		['owner', 'oskar'],
		['allow', 'ana'],
	],
})
const mbp = await scriptedRunner('ana-mbp', route, { query: [['owner', 'ana']] })
const on = (runner) => ({ runner, model: 'echo/echo' })

const listed = (await api('GET', '/api/runners')).json.find((r) => r.name === 'laptop')
check(
	listed?.owner === 'oskar' && JSON.stringify(listed.allow) === '["@desktop"]',
	'a runner says its owner and whom it allows',
	JSON.stringify(listed),
)

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'owners' })
await api('POST', `/api/threads/${id}/entries`, { body: 'hi', to: on('laptop') })
check(Boolean(await answered(id)), 'the owner reaches their runner')

const before = (await view(id)).entries.length
const refused = await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'me too', to: on('laptop') },
	'ana',
)
check(
	refused.status === 403 && refused.json.error === 'laptop takes work only from oskar, @desktop',
	'someone else is refused, and told who it takes work from',
	JSON.stringify(refused),
)
const shell = await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: '$ ls', to: on('laptop') },
	'ana',
)
check(shell.status === 403, 'so is their command', JSON.stringify(shell))
const unaddressed = await api('POST', `/api/threads/${id}/entries`, { body: 'and again' }, 'ana')
check(
	unaddressed.status === 403,
	'and a message that would ask whom the thread last asked',
	JSON.stringify(unaddressed),
)
check((await view(id)).entries.length === before, 'a refusal writes nothing', brief(await view(id)))

// Ana asks an agent on desktop, which desktop allows, to post to laptop, which allows desktop.
const {
	json: { id: hop },
} = await api('POST', '/api/threads', { title: 'hop' }, 'ana')
await api(
	'POST',
	`/api/threads/${hop}/entries`,
	{ body: 'please reach laptop', to: on('desktop') },
	'ana',
)
const child = await until(async () =>
	(await api('GET', '/api/threads')).json.find((t) => t.parent === hop),
)
const reached =
	child &&
	(await until(async () =>
		answers(await view(child.id)).find((e) => e.data.author === 'echo/echo@laptop'),
	))
check(
	Boolean(reached),
	"an allowed runner's agent reaches it, whoever asked that agent",
	child ? brief(await view(child.id)) : 'no child',
)

// The same ask to an agent on ana-mbp: laptop doesn't allow it, and the agent sees why.
const {
	json: { id: own },
} = await api('POST', '/api/threads', { title: 'own' }, 'ana')
await api(
	'POST',
	`/api/threads/${own}/entries`,
	{ body: 'please reach laptop', to: on('ana-mbp') },
	'ana',
)
const said = await until(async () => {
	const v = await view(own)
	return (
		v.status !== 'working' &&
		(await conversationOf(v, 'echo/echo@ana-mbp')).entries
			.filter((e) => e.kind === 'pi.tool-result')
			.map((e) => text(e.model[0]))
			.find((t) => t.includes('takes work only from'))
	)
})
check(
	Boolean(said),
	"an agent on a runner laptop doesn't allow is refused, as a tool error",
	brief(await view(own)),
)
check(
	!(await api('GET', '/api/threads')).json.some((t) => t.parent === own),
	'and starts no thread',
)

laptop.kill()
await until(() =>
	api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === 'laptop' && !x.online)),
)
const offline = await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'now?', to: on('laptop') },
	'ana',
)
check(offline.status === 403, "offline, the runner's last word holds", JSON.stringify(offline))

desktop.close()
mbp.close()
done()
