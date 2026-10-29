// Who wrote what. A thread is plain messages, each with its author and the agents it asks. An agent answers from its
// own Pi conversation, where the thread's messages are stock user input with their authors' names. Someone who names
// no agent asks whom the thread last asked. A model is whatever `pi --model` makes of it on the runner.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	api,
	base,
	check,
	conversationOf,
	dir,
	done,
	runner,
	server,
	text,
} from './lib.js'

await server()
await runner('laptop')

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'test' })
const echo = { runner: 'laptop', model: 'echo/echo' }
const posted = await api('POST', `/api/threads/${id}/entries`, { body: 'hello', to: echo })
check(
	posted.status === 201 && posted.json.entry > 0,
	'posting returns its entry',
	JSON.stringify(posted.json),
)

const view = await answered(id)
const input = view?.entries.find((e) => e.id === posted.json.entry)
const answer = answers(view ?? { entries: [] })[0]
check(
	input?.data.author === 'oskar' && input.data.to?.join() === 'echo/echo@laptop',
	'the message says who wrote it and whom it asks',
	JSON.stringify(input),
)
check(
	answer?.data.author === 'echo/echo@laptop',
	'answer author is the agent',
	JSON.stringify(answer),
)
check(
	answer?.data.re?.[0] === input?.id,
	'the answer says which message it answers (re)',
	JSON.stringify(answer?.data.re),
)
const agent = view?.agents[0]
check(
	view?.agents.length === 1 && agent.name === 'echo/echo@laptop' && agent.to?.model === 'echo/echo',
	'the thread records its agent',
	JSON.stringify(view?.agents),
)

const own = await conversationOf(view, 'echo/echo@laptop')
const user = own.entries?.find((e) => e.kind === 'agent-ide.delivery')
check(
	text(user?.model[0]) === 'oskar: hello' && user.data.held.join() === String(input?.id),
	"in the agent's conversation the message is a delivery: user text with its author, naming what it held",
	JSON.stringify(user),
)
check(
	answer?.data.answer.conversation === agent?.conversation &&
		own.entries.some((e) => e.id === answer.data.answer.entry && e.kind === 'pi.assistant'),
	'the answer points at the entry it came from',
	JSON.stringify(answer?.data.answer),
)
check(
	!(await api('GET', '/api/threads')).json.some((t) => t.id === agent?.conversation),
	"the agent's conversation is no thread",
)

// Ana says something without a `to`: whom the thread last asked answers her, and reads only what's new.
await api('POST', `/api/threads/${id}/entries`, { body: 'me too' }, 'ana')
const v2 = await answered(id, 2)
const ana = v2?.entries.find((e) => e.data.author === 'ana')
check(
	ana?.data.to?.join() === 'echo/echo@laptop',
	'no `to` asks whom the thread last asked',
	JSON.stringify(ana),
)
check(
	answers(v2 ?? { entries: [] })[1]?.data.body === 'echo@laptop heard: ana: me too',
	"the agent catches up on what's new, not its own answer",
	JSON.stringify(v2?.entries.at(-1)),
)

// Cy names the model as pi would let him, by its id with a thinking level: pi resolves it to the same agent, which
// keeps the thinking it was made with.
await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'think hard', to: { runner: 'laptop', model: 'echo:high' } },
	'cy',
)
const v3 = await answered(id, 3)
const cy = v3?.entries.find((e) => e.data.author === 'cy')
check(
	cy?.data.to?.join() === 'echo/echo@laptop' && !v3.agents[0].to.thinkingLevel,
	'pi resolves a pattern to the agent of that name, as it was made',
	JSON.stringify([cy?.data.to, v3?.agents]),
)
check(v3?.agents.length === 1, 'the same model is the same agent', JSON.stringify(v3?.agents))

// Dee names no model: the desk runner's default, pi's own, whose settings name it with its provider as pi takes it too.
const pi = path.join(dir, '..', 'pi')
mkdirSync(pi)
writeFileSync(
	path.join(pi, 'settings.json'),
	JSON.stringify({ defaultProvider: 'echo', defaultModel: 'echo/echo' }),
)
await runner('desk', { env: { PI_CODING_AGENT_DIR: pi } })
const desk = (await api('GET', '/api/runners')).json.find((r) => r.name === 'desk')
check(
	desk?.model === 'echo/echo',
	"a runner's default model is pi's, named once",
	JSON.stringify(desk?.model),
)
const {
	json: { id: id2 },
} = await api('POST', '/api/threads', { title: 'default' })
await api('POST', `/api/threads/${id2}/entries`, { body: 'hi', to: { runner: 'desk' } }, 'dee')
const v4 = await answered(id2)
check(
	answers(v4 ?? { entries: [] })[0]?.data.author === 'echo/echo@desk',
	"no model asks the runner's default",
	JSON.stringify(v4?.entries.at(-1)),
)

// A default model pi can't resolve is said so, not offered.
const odd = path.join(dir, '..', 'odd')
mkdirSync(odd)
writeFileSync(
	path.join(odd, 'settings.json'),
	JSON.stringify({ defaultProvider: 'nowhere', defaultModel: 'nowhere/x' }),
)
await runner('odd', { env: { PI_CODING_AGENT_DIR: odd } })
const lost = (await api('GET', '/api/runners')).json.find((r) => r.name === 'odd')
check(
	!lost?.model && /nowhere/.test(lost?.modelError),
	"a default model pi can't resolve is reported with why",
	JSON.stringify(lost),
)

const page = await (await fetch(`${base}/`)).text()
check(
	page.includes("What it's made of"),
	'the server serves its promises, words and principles on its one page',
)

done()
