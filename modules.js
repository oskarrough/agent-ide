import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** agent-ide.json in the folder it starts in: its settings, which env vars override */
export async function readConfig() {
	const file = path.resolve('agent-ide.json')
	const text = await readFile(file, 'utf8').catch((error) => {
		if (error.code === 'ENOENT') return '{}'
		throw error
	})
	try {
		return { file, config: JSON.parse(text) }
	} catch (error) {
		throw new Error(`${file}: ${error.message}`)
	}
}

/** What a module does: the first sentence of its file's opening comment, or nothing */
export async function about(name) {
	const file = name.includes('/')
		? path.resolve(name)
		: new URL(`./modules/${name}.js`, import.meta.url)
	const text = await readFile(file, 'utf8').catch(() => '')
	const comment = text.match(/^\s*(\/\*\*?[\s\S]*?\*\/|(?:\/\/.*\n?)+)/)?.[1] ?? ''
	return comment
		.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/) ?/gm, '')
		.replace(/\*\/$/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.match(/^.*?\.(?=\s|$)/)?.[0]
}

/** Each module in modules/ → whether it's on by default, from its own `export const on` */
export async function builtIn() {
	const files = (await readdir(new URL('./modules/', import.meta.url))).filter((file) =>
		file.endsWith('.js'),
	)
	return Object.fromEntries(
		await Promise.all(
			files
				.sort()
				.map(async (file) => [
					path.basename(file, '.js'),
					(await import(`./modules/${file}`)).on === true,
				]),
		),
	)
}

/** A module exports `server(core)` and/or `runner(core)`, which return its hooks */
export async function load(end, core, settings) {
	const { file, config } = settings ?? (await readConfig())
	const defaults = await builtIn()
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
		const make = (
			await import(own ? pathToFileURL(path.resolve(name)).href : `./modules/${name}.js`)
		)[end]
		const named = own ? path.basename(name, '.js') : name
		if (modules.some((module) => module.name === named))
			throw new Error(`${file}: two modules are named ${named}; rename one`)
		if (make) modules.push({ name: named, ...(await make(core)) })
	}
	return modules
}

function pick(on, list, where) {
	if (!Array.isArray(list))
		throw new Error(`${where}: modules is a list, like ["+web-search", "-talk"]`)
	const changes = list.filter((name) => /^[+-]/.test(name))
	if (!changes.length) return list
	if (changes.length < list.length)
		throw new Error(
			`${where}: put + or - before every name to change defaults (like +bots,+web-search,+director), or use only bare names to replace them (like bots,web-search,director)`,
		)
	return changes.reduce(
		(on, change) =>
			change[0] === '+'
				? [...new Set([...on, change.slice(1)])]
				: on.filter((name) => name !== change.slice(1)),
		on,
	)
}
