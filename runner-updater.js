// The runner's updater, which `curl -fsSL <server>/connect-runner | sh` downloads and starts. It fetches the runner from
// the server into ~/.agent-ide/runner, installs its packages, runs it, and fetches it again whenever the runner exits
// to update. Built-ins only: nothing is installed when it starts. `--no-update` keeps the runner as it is.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [server, ...given] = process.argv.slice(2)
const updates = !given.includes('--no-update')
const args = given.filter((a) => a !== '--no-update')
const home = process.env.AGENT_IDE_HOME || path.join(os.homedir(), '.agent-ide', 'runner')
const bun = Boolean(process.versions.bun)
if (!server) throw new Error('usage: runner-updater.js <server> [runner options]')
if (!bun && Number(process.versions.node.split('.')[0]) < 24)
	throw new Error("agent-ide's runner needs bun or Node.js 24 or newer")

const read = (file) =>
	existsSync(path.join(home, file)) ? readFileSync(path.join(home, file), 'utf8') : ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The server's runner, installed here; true when that changed anything.
async function install() {
	const bundle = await (await fetch(`${server}/runner/bundle`)).json()
	if (bundle.version === read('version')) return false
	mkdirSync(home, { recursive: true })
	for (const [file, text] of Object.entries(bundle.files))
		writeFileSync(path.join(home, file), text)
	const manifest = JSON.stringify(
		{ name: 'agent-ide-runner', private: true, type: 'module', dependencies: bundle.dependencies },
		null,
		2,
	)
	if (manifest !== read('package.json') || !existsSync(path.join(home, 'node_modules'))) {
		writeFileSync(path.join(home, 'package.json'), manifest)
		const [command, ...rest] = bun
			? [process.execPath, 'install']
			: ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund']
		if (spawnSync(command, rest, { cwd: home, stdio: 'inherit' }).status !== 0)
			throw new Error("installing the runner's packages failed")
	}
	if (!read('version') && !existsSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'))) {
		console.log(
			`No pi logins here yet, so only echo/echo answers. Log in once with ${path.join(home, 'node_modules', '.bin', 'pi')}, then /login.`,
		)
	}
	writeFileSync(path.join(home, 'version'), bundle.version)
	return true
}

let runner
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => (runner ? runner.kill(signal) : process.exit(0)))

// An update that changed nothing would only be asked for again, so after one the runner stops asking.
let stale = false
let asked = false
for (;;) {
	try {
		const changed = await install()
		stale ||= asked && !changed
	} catch (error) {
		if (!read('version')) {
			console.error(`can't fetch the runner from ${server} (${error.message}); retrying…`)
			await sleep(2000)
			continue
		}
		console.error(`can't update from ${server} (${error.message}); running the runner already here`)
		stale ||= asked
	}
	runner = spawn(process.execPath, [path.join(home, 'runner.js'), '--server', server, ...args], {
		stdio: 'inherit',
		env: { ...process.env, ...(updates && !stale ? { AGENT_IDE_LAUNCHER: '1' } : {}) },
	})
	const code = await new Promise((resolve) => runner.on('exit', (code) => resolve(code)))
	if (code !== 75) process.exit(code ?? 0)
	asked = true
}
