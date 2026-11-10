#!/usr/bin/env node
/** One executable; each program still owns its arguments. */
import { parseArgs } from 'node:util'

const args = process.argv.slice(2)
if (args[0] === '--help' || args[0] === '-h') {
	console.log(`agent-ide                   start the server, with this folder as its runner
agent-ide runner …          connect this machine to a server (runner --help)
agent-ide post …            and threads, read, wait, runners, key, revoke, stop (post --help)

PORT, HOST, RUNNER, DB_PATH and MODULES set the server; the README has the rest.`)
} else if (args[0] === 'runner') {
	process.argv.splice(2, 1)
	await import('./runner.js')
} else {
	// Skip CLI option values too: `--as runner key laptop` still asks the CLI.
	const {
		positionals: [command],
	} = parseArgs({
		args,
		strict: false,
		allowPositionals: true,
		options: Object.fromEntries(
			['server', 'as', 'thread', 'to', 'thinking', 'dir', 'title', 'last', 'after'].map((name) => [
				name,
				{ type: 'string' },
			]),
		),
	})
	await import(
		['post', 'threads', 'read', 'wait', 'runners', 'key', 'revoke', 'stop'].includes(command)
			? './cli.js'
			: './server.js'
	)
}
