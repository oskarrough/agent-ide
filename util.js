/** Helpers the server and its modules share */

/** A durable task's terminal result */
export const finished = (status = 'completed', result = null) => ({
	status: 'terminal',
	outcome: { status, result },
})

/** A background task owned by its thread */
export const background = (threadId) => ({
	ownership: { kind: 'conversation' },
	conversationId: threadId,
	background: true,
})

export async function collect(scan) {
	const items = []
	let cursor
	do {
		const page = await scan(cursor)
		items.push(...page.items)
		cursor = page.next
	} while (cursor)
	return items
}

/** How a `to` is written, shown and typed alike: a bot's name, or the thread's agent as `model:thinking@runner`, the
 * model by its own name without its provider */
export const writtenTo = (to) =>
	to &&
	(to.name ??
		`${to.model.split('/').pop()}${to.thinkingLevel ? `:${to.thinkingLevel}` : ''}@${to.runner}`)
/** The thread's own agent's key among its agents; bots are keyed by name */
export const AGENT = 'agent'
/** Bot names have no `@`, so any name with one is the thread's agent, whatever model it had */
export const keyOf = (name) => (name.includes('@') ? AGENT : name)
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** `model:thinking@runner`, each part but the runner optional; `ada=model@runner` asks the bot ada as that */
export const agentTo = (name) => {
	const eq = name.indexOf('=')
	const agent = name.slice(eq + 1)
	const at = agent.lastIndexOf('@')
	let model = at < 0 ? '' : agent.slice(0, at),
		thinkingLevel
	const colon = model.lastIndexOf(':')
	if (colon >= 0 && THINKING_LEVELS.includes(model.slice(colon + 1)))
		[model, thinkingLevel] = [model.slice(0, colon), model.slice(colon + 1)]
	return {
		runner: agent.slice(at + 1),
		model,
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(eq > 0 ? { name: name.slice(0, eq) } : {}),
	}
}
/** A person's name as one line of printable text, so no author can write a speaker line of their own */
export const speaker = (name) =>
	[
		...String(name ?? '')
			.normalize('NFKC')
			.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	]
		.slice(0, 40)
		.join('')
		.trim() || 'anon'

export function field(value, name) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
	return value.trim()
}

/** Whether an agent wrote it, in this thread or from another */
export const byAgent = (message) => Boolean(message.answer || message.error || message.from)

/** A message's text, with what its shell command gave */
export const written = (message) =>
	`${message.body}${
		message.shell
			? `\n${[`exit ${message.shell.code ?? message.shell.error}`, message.shell.stdout, message.shell.stderr].filter(Boolean).join('\n')}`
			: ''
	}`

/** A message as an agent reads it: inside a tag that names who wrote it, or, a person's when `plain`, as typed */
export function said({ data: message }, plain = false) {
	if (plain && !byAgent(message)) return written(message)
	const from = String(message.author).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
	const agent = byAgent(message)
		? ` agent${message.from ? ` thread="${message.from}"${message.re ? ' answering' : ''}` : ''}`
		: ''
	/** A body can't open or close a tag of this name, so nothing in it can pass for someone else's message */
	return `<message from="${from}"${agent}>\n${written(message).replace(/<(\/?message)/gi, '&lt;$1')}\n</message>`
}

/** Bot names a message @mentions, in mention order, ignoring case and trailing dots. */
export function mentioned(body, names) {
	const bots = new Map(names.map((name) => [name.toLowerCase(), name]))
	return [
		...new Set(
			[...body.matchAll(/@([\w.-]+)/g)]
				.map(([, name]) => bots.get(name.replace(/\.+$/, '').toLowerCase()))
				.filter(Boolean),
		),
	]
}
