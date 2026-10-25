// The CLI sends to any agents, in a new thread or an old one, and prints their answers as they land.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { base, check, done, repo, runner, server } from './lib.js'

const cli = async (...args) => {
	const { stdout, stderr } = await promisify(execFile)(
		process.execPath,
		['cli.js', '--server', base, '--as', 'oskar', ...args],
		{ cwd: repo },
	)
	return stdout + stderr
}

await server()
await runner('laptop')
await runner('desk')

const first = await cli('post', '--to', 'echo/echo@laptop', 'hello')
const id = /thread (\d+)/.exec(first)?.[1]
check(
	id && first.includes('echo/echo@laptop') && first.includes('echo@laptop heard: oskar: hello'),
	'post starts a thread and prints the answer',
	first,
)

const both = await cli(
	'post',
	'--thread',
	id,
	'--to',
	'echo/echo@laptop',
	'--to',
	'echo/echo@desk',
	'both of you',
)
check(
	both.includes('echo@laptop heard') && both.includes('echo@desk heard'),
	'two agents on two runners, one message, both answers',
	both,
)

const again = await cli('post', '--thread', id, 'and again')
check(
	/#\d+ echo\/echo@laptop\n/.test(again) && /#\d+ echo\/echo@desk\n/.test(again),
	'no --to asks whom the thread last asked',
	again,
)

const shell = await cli('post', '--thread', id, '--to', 'echo/echo@desk', '$ echo from-desk')
check(
	shell.includes('from-desk'),
	'a $ command runs on the runner named and prints its output',
	shell,
)

const threads = await cli('threads')
check(
	threads.includes(`#${id} hello`) && threads.includes('echo/echo@desk'),
	'threads lists it with its agents',
	threads,
)
const read = await cli('read', id, '--last', '1')
check(
	read.includes('from-desk') && !read.includes('hello'),
	'read --last 1 prints only the last message',
	read,
)
const runners = await cli('runners')
check(
	runners.includes('laptop online') && runners.includes('desk online'),
	'runners lists both',
	runners,
)
done()
