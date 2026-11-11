/** With pi-sessions on, an agent's conversation is a pi session file on its runner: pi loads it, lists it for the folder, it only grows, and a fork gets a file of its own */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	api,
	call,
	check,
	dir,
	done,
	kill,
	localRunner,
	online,
	repo,
	say,
	server,
	text,
	until,
	view,
} from './lib.js'

// Pi's own folder for this run, inside the workspace: no session lands in the real one
const pi = mkdtempSync(path.join(repo, 'pi-sessions-'))
process.on('exit', () => rmSync(pi, { recursive: true, force: true }))
process.env.PI_CODING_AGENT_DIR = pi
delete process.env.PI_CODING_AGENT_SESSION_DIR

let srv = await server({ MODULES: '+pi-sessions' })
const script = fauxProvider({
	provider: 'script',
	models: [
		{ id: 'one', reasoning: true },
		{ id: 'two', reasoning: true },
	],
	tokensPerSecond: 200,
})
script.setResponses(
	Array.from({ length: 200 }, () => (context) => {
		if (JSON.stringify(context.messages).includes('context summarization assistant'))
			return say('SUMMARY OF EARLIER WORK')
		const asked = context.messages.findLastIndex((message) => message.role === 'user')
		const results = context.messages.slice(asked).filter((message) => message.role === 'toolResult')
		return results.length
			? say(`It printed ${text(results[0]).trim()}.`)
			: call('bash', { command: 'echo secret-42' })
	}),
)
const models = createModels()
models.setProvider(script.provider)
await localRunner('laptop', {
	models,
	resolve: (pattern) => ({
		model: script.getModel(String(pattern).split('/').pop()) ?? script.getModel(),
	}),
	echo: script,
	model: 'script/one',
})

const sessions = async () => (await SessionManager.list(dir)).filter((info) => info.cwd === dir)
/** Pi's own loading of the one file there is, once its newest message is what we wait for */
const loaded = async (file, newest) => {
	let session
	await until(async () => {
		session = SessionManager.open(file)
		return text(session.buildSessionContext().messages.at(-1) ?? { content: '' }).includes(newest)
	})
	return session
}
const roles = (session) => session.buildSessionContext().messages.map((message) => message.role)

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'pi sessions' })
const post = (thread, body, to) => api('POST', `/api/threads/${thread}/entries`, { body, to })
await post(id, 'run echo secret-42', { runner: 'laptop', model: 'script/one' })
await answered(id)
await until(async () => (await sessions()).length === 1)
const [listed] = await sessions()
check(
	listed?.cwd === dir,
	'pi lists the session for the agent’s folder, as pi --resume would',
	JSON.stringify(listed),
)
const sessionIdOf = async (thread) =>
	(await api('GET', `/api/conversations/${(await view(thread)).agents[0].conversation}`)).json.docs[
		'pi.provider'
	].sessionId
check(
	listed.id === (await sessionIdOf(id)) && /^[0-9a-f-]{36}$/.test(listed.id),
	'the session’s id is the conversation’s own, a UUID',
	listed.id,
)
let session = await loaded(listed.path, 'It printed secret-42.')
check(
	roles(session).join() === 'user,assistant,toolResult,assistant',
	'pi loads it: the question, the tool call, its result and the answer',
	roles(session).join(),
)
const [user, call1, result, final] = session.buildSessionContext().messages
check(
	text(user).includes('run echo secret-42'),
	'the agent’s message is what the agent was handed',
	text(user),
)
const tool = call1.content.find((part) => part.type === 'toolCall')
check(
	tool?.name === 'bash' &&
		tool.arguments.command === 'echo secret-42' &&
		result.toolCallId === tool.id,
	'the tool call and its result are linked as pi expects',
	JSON.stringify(call1.content),
)
check(
	session.buildSessionContext().model?.modelId === 'one' &&
		session
			.getEntries()
			.every((entry) => entry.type !== 'message' || entry.message.role !== 'system'),
	'it names the model, and carries no system message that would stand in for pi’s own',
	JSON.stringify(session.buildSessionContext().model),
)
const before = readFileSync(listed.path, 'utf8')

await post(id, 'again, as two', { runner: 'laptop', model: 'script/two', thinkingLevel: 'high' })
await answered(id, 2)
await until(async () => roles((session = SessionManager.open(listed.path))).length === 8)
const entries = session.getEntries()
check(readFileSync(listed.path, 'utf8').startsWith(before), 'the file only grows')
check(
	entries.every((entry, at) => entry.parentId === (entries[at - 1]?.id ?? null)),
	'every entry follows the one before it',
)
check(
	entries
		.filter((entry) => entry.type === 'model_change')
		.map((entry) => entry.modelId)
		.join() === 'one,two' &&
		session.buildSessionContext().model?.modelId === 'two' &&
		session.buildSessionContext().thinkingLevel === 'high',
	'switching the agent’s model and thinking is a model change and a thinking change',
	entries.map((entry) => entry.type).join(),
)

// A restarted server picks up where the file ends, without repeating anything
await kill(srv)
srv = await server({ MODULES: '+pi-sessions' })
await online('laptop')
await post(id, 'once more', { runner: 'laptop', model: 'script/two', thinkingLevel: 'high' })
await answered(id, 3)
await until(async () => roles((session = SessionManager.open(listed.path))).length === 12)
const ids = session.getEntries().map((entry) => entry.id)
check(new Set(ids).size === ids.length, 'after a restart nothing is written twice', ids.join())
check((await sessions()).length === 1, 'still one file for the one conversation')

// A compaction is pi's own: its summary stands for the older messages, and the file points at the first one kept
const long = (await api('POST', '/api/threads', { title: 'a long one' })).json.id
for (let turn = 1; turn <= 12; turn++) {
	await post(
		long,
		`turn ${turn} ${'long '.repeat(2400)}`,
		turn === 1 ? { runner: 'laptop', model: 'script/one' } : undefined,
	)
	await answered(long, turn)
}
const { json: compacted } = await api('POST', `/api/threads/${long}/compact`, {})
check(compacted.compacted?.[0] === 'completed', 'the thread compacts', JSON.stringify(compacted))
await until(async () => (await sessions()).length === 2)
const [longer] = (await sessions()).filter((info) => info.path !== listed.path)
await until(async () =>
	SessionManager.open(longer.path)
		.getEntries()
		.some((entry) => entry.type === 'compaction'),
)
session = SessionManager.open(longer.path)
const cut = session.getEntries().find((entry) => entry.type === 'compaction')
const [summary, kept] = session.buildSessionContext().messages
check(
	cut.summary === 'SUMMARY OF EARLIER WORK' && summary.role === 'compactionSummary',
	'pi reads the compaction as its own, with the summary and none of agent-ide’s wrapping',
	JSON.stringify(cut.summary),
)
check(
	session.getEntries().some((entry) => entry.id === cut.firstKeptEntryId) &&
		kept.role !== 'compactionSummary',
	'it keeps the messages from the first one the compaction kept',
	cut.firstKeptEntryId,
)

// A fork has its own file, with the history up to where it forked
const source = (await api('GET', `/api/threads/${id}`)).json
const fork = (await api('POST', `/api/threads/${id}/fork`, { at: answers(source)[0].id })).json.id
await post(fork, 'and in the fork', { runner: 'laptop', model: 'script/one' })
await answered(fork, 2)
await until(async () => (await sessions()).length === 3)
const [own] = (await sessions()).filter((info) => ![listed.path, longer.path].includes(info.path))
await until(async () => roles((session = SessionManager.open(own.path))).length === 8)
check(
	roles(session).join() ===
		'user,assistant,toolResult,assistant,user,assistant,toolResult,assistant',
	'the fork’s file is its own: the history it kept, then its own turn',
	roles(session).join(),
)
check(
	own.id === (await sessionIdOf(fork)) && own.id !== listed.id,
	'a fork’s file has the fork’s own id',
)
check(
	SessionManager.open(listed.path).buildSessionContext().messages.length === 12,
	'and the source’s file is as it was',
)

// Someone carries on in pi: agent-ide never reads it, and goes on from its own last entry
const piTurn = {
	type: 'message',
	id: 'a1b2c3d4',
	parentId: SessionManager.open(listed.path).getLeafId(),
	timestamp: new Date().toISOString(),
	message: { role: 'user', content: 'asked in pi', timestamp: Date.now() },
}
appendFileSync(listed.path, `${JSON.stringify(piTurn)}\n`)
await post(id, 'back in agent-ide', {
	runner: 'laptop',
	model: 'script/two',
	thinkingLevel: 'high',
})
await answered(id, 4)
await until(
	async () => SessionManager.open(listed.path).buildSessionContext().messages.length === 16,
)
session = SessionManager.open(listed.path)
check(
	session.getEntries().some((entry) => entry.id === 'a1b2c3d4') &&
		!session
			.buildSessionContext()
			.messages.some((message) => text(message).includes('asked in pi')),
	'what pi added stays in the file as a branch of its own; agent-ide’s turns go on beside it',
)
done()
