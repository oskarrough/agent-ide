/** Startup explains module choices and prints one local URL, even with IPv6 listening. */
import { check, done, start, until } from './lib.js'

for (const [modules, host, expected] of [
	[
		'-bots,-director,+bots,+web-search,+director',
		'',
		'auto-title,context,memory,status,talk,bots,web-search,director',
	],
	['bots,web-search,director', '', 'bots,web-search,director'],
	['-talk,-status,-bots,-director', '::1', 'auto-title,context,memory'],
	['+bots,web-search,director', '', null],
]) {
	let output = ''
	const child = start('server.js', [], { PORT: '0', HOST: host, RUNNER: '0', MODULES: modules })
	child.stdout.on('data', (data) => {
		output += data
	})
	child.stderr.on('data', (data) => {
		output += data
	})
	const exited = new Promise((resolve) => child.once('exit', resolve))
	try {
		const ready = await until(async () => child.exitCode !== null || /http:\/\//.test(output))
		check(ready, `${modules}: starts or explains the error`, output)
		if (!expected) {
			check(
				output.includes('+bots,+web-search,+director'),
				'mixed prefixes show the corrected command',
				output,
			)
			continue
		}
		const url = output.match(/http:\/\/\S+/)?.[0]
		const state = url && (await until(async () => (await fetch(`${url}/api/server`)).json()))
		check(state?.modules.join() === expected, `${modules}: loads ${expected}`, output)
		check(output.match(/http:\/\//g)?.length === 1, 'one server URL', output)
		check(
			!expected.includes('talk') === /defaults left out: .*\btalk\b/.test(output),
			'a default that a list of names left out says so',
			output,
		)
		if (host) check(url?.includes('[::1]'), 'explicit IPv6 address is still printed', output)
	} finally {
		child.kill()
		await exited
	}
}
done()
