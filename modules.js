import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// A module exports `server(core)` and/or `runner(core)`, which return its hooks:
//   server: extension, route(posted, agents) → To[], reply(posts, answeredIn, agent, body) → [{ thread, data }], changed(),
//           posted(tx, threadId, entry): work added to a post's commit, writes only,
//           catchUp(threadId, held, all, agent) → the content of a Deliver task's input to that agent's conversation,
//           serve(threadId, query) → what GET /api/threads/:id/<module name> answers
//   runner: told(message), disconnected(), ops: { [op]: (message, context) → what the runner answers the server's call }
// Which are on: the defaults, then `modules` in agent-ide.json in the folder it starts in, then an env var of the
// module's name. A name with a slash is a module of your own, a path from that folder, named after its file.
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
	const all = { ...defaults, ...config.modules }
	const on = Object.keys(all).filter((name) => {
		const value = !name.includes('/') && process.env[name.toUpperCase()]
		return value ? value !== '0' : all[name]
	})
	const modules = []
	for (const name of on) {
		const own = name.includes('/')
		const make = (await import(own ? pathToFileURL(path.resolve(name)).href : `./${name}.js`))[end]
		if (make) modules.push({ name: own ? path.basename(name, '.js') : name, ...(await make(core)) })
	}
	return modules
}
