/**
 * Shows on a runner's terminal what its agents are doing, in the Program Status Protocol (OSC 7501):
 * https://www.superlogical.com/rex/docs/build/program-status. The root record is the runner, one record per thread
 * that's working, done or error. Terminals ignore what they don't speak, so it writes whenever stdout is a terminal.
 * On by default; MODULES=-status turns it off. STATUS=1 writes even when stdout isn't a terminal.
 */

export const on = true

/** One telling at a time, so an older one never lands after a newer one */
export function server({ runners, known, threadList }) {
	let telling
	let again = false
	function changed() {
		if (telling) return void (again = true)
		telling = (async () => {
			const all = await known()
			for (const name of Object.keys(all).filter(runners.isOnline)) {
				const threads = (await threadList(all[name].owner))
					.map((thread) => ({
						...thread,
						agents: thread.agents
							.filter((agent) => agent.to?.runner === name)
							.map((agent) => agent.name)
							.join(' '),
					}))
					.filter((thread) => thread.agents && ['working', 'done', 'error'].includes(thread.status))
					.map(({ id, title, agents, status }) => ({ id, title, agents, status }))
				runners.tell(name, { op: 'status', threads })
			}
		})()
			.catch((error) => console.error(error))
			.finally(() => {
				telling = undefined
				if (again) {
					again = false
					changed()
				}
			})
	}
	return { changed }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g
/** Free text as the spec has it: one line of UTF-8, at most `max` bytes, in base64 */
function text(value, max) {
	let cut = ''
	for (const character of value.replace(CONTROL_CHARACTERS, ' ').trim())
		if (Buffer.byteLength(cut + character) <= max) cut += character
		else break
	return Buffer.from(cut).toString('base64')
}
/** One report; it replaces its record whole, so every key it should keep is in it */
const report = (pairs) =>
	`\x1b]7501;${Object.entries(pairs)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join(':')}\x1b\\`

export function runner({ name, server }) {
	if (!process.stdout.isTTY && process.env.STATUS !== '1') return {}
	let shown = new Map()
	function show(root, threads = []) {
		const next = new Map([
			['', report({ state: root.state, app: 'agent-ide', msg: text(root.msg, 2048) })],
		])
		for (const thread of threads)
			next.set(
				String(thread.id),
				report({
					state: thread.status,
					id: thread.id,
					title: text(`#${thread.id} ${thread.title}`, 192),
					msg: text(thread.agents, 2048),
				}),
			)
		for (const id of shown.keys())
			if (!next.has(id)) process.stdout.write(report({ state: 'clear', id }))
		for (const [id, sequence] of next)
			if (shown.get(id) !== sequence) process.stdout.write(sequence)
		shown = next
	}
	return {
		told({ threads }) {
			const working = threads.filter((thread) => thread.status === 'working').length
			show(
				{
					state: working ? 'working' : 'idle',
					msg: `${name}: ${working ? `${working} working` : 'online'}`,
				},
				threads,
			)
		},
		disconnected: () => show({ state: 'error', msg: `${name}: offline, retrying ${server}` }),
	}
}
