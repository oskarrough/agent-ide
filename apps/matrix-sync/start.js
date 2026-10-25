// agent-ide with its Matrix bridge, set up so that each Matrix thread where the bot is mentioned is one GitHub issue. Reads .env beside it,
// from wherever it is run.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const dotenv = path.join(import.meta.dirname, '.env')
if (existsSync(dotenv)) process.loadEnvFile(dotenv)
const { REPO, MODEL = 'openai-codex/gpt-6-luna', PORT = '3009' } = process.env
const repo = REPO && path.resolve(REPO.replace(/^~(?=\/|$)/, os.homedir()))
if (!repo || !existsSync(repo))
	throw new Error(`Set REPO in ${dotenv} to a local GitHub checkout where \`gh\` is logged in`)

const env = {
	...process.env,
	PORT,
	DB_PATH: path.join(import.meta.dirname, 'matrix-sync.sqlite'),
	MATRIX: '1',
	MATRIX_AGENT: `${MODEL}@issues`,
	MATRIX_BRIEF:
		'Each Matrix thread is one GitHub issue. The first time you are asked here, file what they report: ' +
		'`gh issue create --title "<what they report, in your own words>" --body-file -`, the body on stdin from a quoted heredoc: their words quoted with `> `, ' +
		'and answer with its link. ' +
		"When asked again, add what they say to that issue with `gh issue comment --body-file -` the same way, and answer with the comment's link.",
}
const run = (file, args = []) =>
	spawn(process.execPath, [path.join(root, file), ...args], { env, stdio: 'inherit' })
run('server.js')
run('runner.js', ['--server', `http://127.0.0.1:${PORT}`, '--name', 'issues', '--dir', repo])
