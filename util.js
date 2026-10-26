// Pure helpers the server and its modules share: nothing here touches state.

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

// An agent's seat in its thread: its label, or `model@runner` by default.
export const agentName = (to) => to && (to.label ?? `${to.model}@${to.runner}`)
// `model@runner`, or a bare runner for its default model; `label=model@runner` names the seat it makes.
export const agentTo = (name) => {
	const eq = name.indexOf('=')
	const recipe = name.slice(eq + 1)
	const at = recipe.lastIndexOf('@')
	return {
		runner: recipe.slice(at + 1),
		model: at < 0 ? '' : recipe.slice(0, at),
		...(eq > 0 ? { label: name.slice(0, eq) } : {}),
	}
}
// A person's name as one line of printable text, so no author can write a speaker line of their own.
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

// A message as an agent reads it: a speaker line, then its later lines indented, so no body can start a line that
// looks like someone speaking. Agents are marked by what they wrote, never by their name: an answer, or a post.
export function said({ data: m }) {
	const agent = Boolean(m.answer || m.error || m.from)
	const who = agent
		? `${m.author} (agent${m.from ? `, ${m.re ? 'answering' : 'writing'} from thread ${m.from}` : ''})`
		: m.author
	const output = m.shell
		? `\n${[`exit ${m.shell.code ?? m.shell.error}`, m.shell.stdout, m.shell.stderr].filter(Boolean).join('\n')}`
		: ''
	return `${who}: ${`${m.body}${output}`.replace(/\n/g, '\n  ')}`
}
