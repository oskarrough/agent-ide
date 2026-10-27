import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// A module exports `server(core)` and/or `runner(core)`, which return its hooks:
//   server: extension, route(posted, agents) → To[], reply(posts, answeredIn, agent, body) → [{ thread, data }], changed(),
//           posted(tx, threadId, entry): work added to a post's commit, writes only,
//           hiding(tx, threadId): work added to hiding a thread's commit, which a throw refuses,
//           catchUp(threadId, held, all, agent) → the content of a Deliver task's input to that agent's conversation,
//           serve(threadId, query, body?) → what GET, or POST with a body, /api/threads/:id/<module name> answers,
//           and /api/<module name> with no threadId; remove(name) → what DELETE /api/<module name>/:name answers,
//           recipe(name) → the To a name stands for in a thread without an agent of that name, or undefined
//   runner: call(message, context) → what the runner answers the server's call, told(message), disconnected()
// The server reaches a module on a runner by its name: a call or a message with `op` set to it, as serve's route is.
// Which are on, the way Pi picks its tools: the defaults, then `modules` in agent-ide.json in the folder it starts in,
// then MODULES, comma-separated. A list of names replaces what's on; a list of only +name and -name changes it, in
// order. A name with a slash is a module of your own, a path from that folder, named after its file. A name only the
// other end has is skipped, so one MODULES serves the server and the runner it lends.
export async function load(end, defaults, core) {
	const file = path.resolve('agent-ide.json')
	const text = await readFile(file, 'utf8').catch((error) => {
		if (error.code === 'ENOENT') return '{}'
		throw error
	})
	let config
	try {
		config = JSON.parse(text)
	} catch (error) {
		throw new Error(`${file}: ${error.message}`)
	}
	let on = Object.keys(defaults).filter((name) => defaults[name])
	for (const [where, list] of [
		[file, config.modules],
		['MODULES', process.env.MODULES ? process.env.MODULES.split(',') : undefined],
	])
		if (list) on = pick(on, list, where)
	const theirs = (name) => !name.includes('/') && !(name in defaults)
	if (end === 'server' && on.some(theirs)) throw new Error(`no module named ${on.find(theirs)}`)
	on = on.filter((name) => !theirs(name))
	const modules = []
	for (const name of on) {
		const own = name.includes('/')
		const make = (await import(own ? pathToFileURL(path.resolve(name)).href : `./${name}.js`))[end]
		const named = own ? path.basename(name, '.js') : name
		// Two modules of one name would answer one route; that's a mistake, not an order.
		if (modules.some((m) => m.name === named))
			throw new Error(`${file}: two modules are named ${named}; rename one`)
		if (make) modules.push({ name: named, ...(await make(core)) })
	}
	return modules
}

function pick(on, list, where) {
	if (!Array.isArray(list))
		throw new Error(`${where}: modules is a list, like ["+search", "-talk"]`)
	const changes = list.filter((name) => /^[+-]/.test(name))
	if (!changes.length) return list
	if (changes.length < list.length)
		throw new Error(`${where}: names can't be mixed with +name or -name`)
	return changes.reduce(
		(on, change) =>
			change[0] === '+'
				? [...new Set([...on, change.slice(1)])]
				: on.filter((name) => name !== change.slice(1)),
		on,
	)
}
