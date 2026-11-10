/** The installed executable routes commands without eating their options. */
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { check, done, repo, start, until } from './lib.js'

const bin = JSON.parse(readFileSync(`${repo}/package.json`)).bin['agent-ide']
const server = start(bin, [], { RUNNER: '0' })
let output = ''
server.stdout.on('data', (chunk) => {
	output += chunk
})
check(
	await until(async () => /http:\/\/127\.0\.0\.1:\d+/.test(output)),
	'no arguments starts the server',
	output,
)
const base = /http:\/\/127\.0\.0\.1:\d+/.exec(output)[0]
const run = async (...args) =>
	(
		await promisify(execFile)(process.execPath, [`${repo}/${bin}`, ...args], {
			env: { ...process.env, AGENT_IDE_SERVER: base },
		})
	).stdout
check((await run('runner', '--help')).includes('--key-file'), 'runner dispatch removes only runner')
check((await run('key', 'laptop')).includes('connect-runner'), 'key dispatch reaches the server')
check(
	(await run('--server', base, '--as', 'runner', 'runners')).includes('laptop'),
	'leading CLI options and command-like option values stay intact',
)
await run('post', '--to', 'nobody', '--no-wait', 'runner')
const id = /#(\d+)/.exec(await run('threads'))[1]
check(
	(await run('read', id)).includes('runner'),
	'command-like message is not mistaken for runner dispatch',
)
check((await run('threads')).includes('runner'), 'threads dispatch')
check((await run('revoke', 'laptop')).includes('revoked'), 'revoke dispatch')
for (const flag of ['--help', '-h']) {
	const { stdout } = await promisify(execFile)(process.execPath, [`${repo}/${bin}`, flag], {
		timeout: 8000,
	})
	check(
		stdout.includes('runner') && stdout.includes('post'),
		`${flag} says what it runs, without starting a server`,
		stdout,
	)
}
done()
