/** A pi session in a runner's folder starts a thread: only its active branch comes, the agent is handed it on the next turn, the source file stays as it was, and importing again makes another thread */
import { createModels } from '@earendil-works/pi-ai/models'
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	base,
	check,
	dir,
	done,
	localRunner,
	repo,
	server,
	text,
	until,
	view,
} from './lib.js'

// Pi's own folder for this run, inside the workspace: no session lands in the real one
const pi = mkdtempSync(path.join(repo, 'pi-import-'))
process.on('exit', () => rmSync(pi, { recursive: true, force: true }))
process.env.PI_CODING_AGENT_DIR = pi
delete process.env.PI_CODING_AGENT_SESSION_DIR

await server({ MODULES: '+pi-sessions' })
const script = fauxProvider({
	provider: 'script',
	models: [{ id: 'one', reasoning: true }],
	tokensPerSecond: 200,
})
/** The agent reports what it was handed: how many messages besides its instructions, and all of their words */
script.setResponses(
	Array.from({ length: 50 }, () => (context) => {
		const handed = context.messages.filter((message) => message.role !== 'system')
		return fauxAssistantMessage([
			fauxText(`handed ${handed.length}: ${JSON.stringify(handed).replace(/"/g, '')}`),
		])
	}),
)
const models = createModels()
models.setProvider(script.provider)
await localRunner('laptop', {
	models,
	resolve: (pattern) => ({ model: script.getModel(String(pattern).split('/').pop()) }),
	echo: script,
	model: 'script/one',
})

// A pi session with a branch: pi was asked, took the other road, and the session ended on it
const said = (content, extra = {}) => ({
	...fauxAssistantMessage(content, extra),
	provider: 'script',
	model: 'one',
})
const now = Date.now()
const session = SessionManager.create(dir)
session.appendSessionInfo('Looking at secrets')
session.appendModelChange('script', 'one')
session.appendThinkingLevelChange('high')
session.appendMessage({ role: 'user', content: 'run echo secret-42', timestamp: now })
const first = session.appendMessage(
	said([fauxToolCall('bash', { command: 'echo secret-42' }, { id: 'call_1' })], {
		stopReason: 'toolUse',
	}),
)
session.appendMessage({
	role: 'toolResult',
	toolCallId: 'call_1',
	toolName: 'bash',
	content: [fauxText('secret-42')],
	isError: false,
	timestamp: now,
})
const answer = session.appendMessage(said([fauxText('It printed secret-42.')]))
session.appendMessage({ role: 'user', content: 'the road not taken', timestamp: now })
session.appendMessage(said([fauxText('A dead end.')]))
session.branch(answer)
session.appendMessage({ role: 'user', content: 'and the other one?', timestamp: now })
session.appendMessage(said([fauxText('The other one is Friday.')]))
const file = session.getSessionFile()
const before = readFileSync(file, 'utf8')

const { json: listed } = await api('GET', '/api/pi-sessions?runner=laptop')
check(
	listed.length === 1 && listed[0].path === file && listed[0].name === 'Looking at secrets',
	'the folder’s pi sessions are listed, by their name',
	JSON.stringify(listed),
)
const brought = await api('POST', '/api/pi-sessions', {
	runner: 'laptop',
	session: file,
	author: 'oskar',
})
check(
	brought.status < 300 && brought.json.id,
	'a session comes in as a new thread',
	JSON.stringify(brought.json),
)
const id = brought.json.id
let thread = await view(id)
check(thread.title === 'Looking at secrets', 'it is titled by the session’s name', thread.title)
check(
	thread.entries.map((entry) => `${entry.data.author}: ${entry.data.body}`).join(' | ') ===
		'oskar: run echo secret-42 | one:high@laptop: It printed secret-42. | oskar: and the other one? | one:high@laptop: The other one is Friday.',
	'the thread shows the active branch only: the person’s words, and what the agent last said each turn',
	JSON.stringify(thread.entries.map((entry) => entry.data.body)),
)
check(
	thread.agents[0]?.to?.model === 'script/one' &&
		thread.agents[0].to.thinkingLevel === 'high' &&
		thread.agents[0].to.runner === 'laptop',
	'its agent has the session’s last model and thinking, on that runner',
	JSON.stringify(thread.agents),
)
check(
	(await api('GET', `/api/threads/${id}/pi-sessions`)).json.from?.file === file,
	'the thread remembers the file it came from',
)

// The next turn is handed the imported conversation, not the thread's words about it
await api('POST', `/api/threads/${id}/entries`, {
	body: 'what now?',
	to: { runner: 'laptop', model: 'script/one' },
})
thread = await answered(id, 3)
const reply = thread.entries.findLast((entry) => entry.data.answer).data.body
check(
	reply.startsWith('handed 7:'),
	'the agent is handed the six imported messages and the new one',
	reply.slice(0, 60),
)
check(
	reply.includes('secret-42') &&
		reply.includes('toolCall') &&
		reply.includes('The other one is Friday'),
	'with the tool call and its result',
)
check(
	!reply.includes('dead end') && !reply.includes('not taken'),
	'and nothing of the branch left behind',
)

// Its own export is a new file; the source is never written to
await until(async () => (await SessionManager.list(dir)).length === 2)
const exported = (await SessionManager.list(dir)).find((info) => info.path !== file)
check(
	exported.id !== listed[0].id && readFileSync(file, 'utf8') === before,
	'the new thread writes a file of its own, and the source is as it was',
	exported.id,
)

// A pi compaction stays one: what it summarized is stored but not handed over
const compacted = SessionManager.create(dir)
compacted.appendMessage({ role: 'user', content: 'old question', timestamp: now })
compacted.appendMessage(said([fauxText('old answer')]))
const kept = compacted.appendMessage({ role: 'user', content: 'kept question', timestamp: now })
compacted.appendMessage(said([fauxText('kept answer')]))
compacted.appendCompaction('EARLIER: the old exchange', kept, 1000)
compacted.appendMessage({ role: 'user', content: 'newer question', timestamp: now })
compacted.appendMessage(said([fauxText('newer answer')]))
const second = await api('POST', '/api/pi-sessions', {
	runner: 'laptop',
	session: compacted.getSessionFile(),
})
await api('POST', `/api/threads/${second.json.id}/entries`, {
	body: 'go on',
	to: { runner: 'laptop', model: 'script/one' },
})
const gone = (await answered(second.json.id, 3)).entries.findLast((entry) => entry.data.answer).data
	.body
check(
	gone.startsWith('handed 6:') &&
		gone.includes('EARLIER: the old exchange') &&
		gone.includes('kept question') &&
		gone.includes('newer answer') &&
		!gone.includes('old question') &&
		!gone.includes('old answer'),
	'the summary, what it kept and what came after are handed over, not what it summarized',
	gone.slice(0, 200),
)

// More work in pi, imported again, is another thread
const again = await api('POST', '/api/pi-sessions', { runner: 'laptop', session: listed[0].id })
check(
	again.json.id && again.json.id !== id,
	'importing again makes another thread',
	JSON.stringify(again.json),
)
// The CLI lists a folder's sessions and brings one in
const cli = async (...args) =>
	(
		await promisify(execFile)(
			process.execPath,
			[path.join(repo, 'cli.js'), '--server', base, ...args],
			{
				encoding: 'utf8',
			},
		)
	).stdout
check(
	(await cli('import', 'laptop')).includes(`${listed[0].id}`) &&
		(await cli('import', 'laptop')).includes('Looking at secrets'),
	'the CLI lists them',
)
const viaCli = /^thread (\d+)/.exec(
	await cli('import', 'laptop', listed[0].id, '--title', 'from the CLI'),
)?.[1]
check(
	viaCli && (await view(viaCli)).title === 'from the CLI',
	'and brings one in under a title of your own',
	viaCli,
)

const missing = await api('POST', '/api/pi-sessions', { runner: 'laptop', session: 'nothing' })
check(missing.status >= 400, 'a session that isn’t there is refused', JSON.stringify(missing.json))
done()
