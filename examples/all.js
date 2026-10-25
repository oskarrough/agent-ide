// Every example at once, each with its own server, port and store; each one's output shows whole when it ends.
// The real-model examples spend tokens, so they only run with REAL=1.
import { readdirSync } from 'node:fs'

const files = readdirSync(import.meta.dirname)
	.filter((f) => /^\d\d-.*\.js$/.test(f) && (process.env.REAL || !f.includes('real-model')))
	.sort()
const started = performance.now()
const failed = (
	await Promise.all(
		files.map(async (file) => {
			const p = Bun.spawn([process.execPath, `${import.meta.dirname}/${file}`], {
				stdout: 'pipe',
				stderr: 'pipe',
			})
			const [out, err, code] = await Promise.all([
				new Response(p.stdout).text(),
				new Response(p.stderr).text(),
				p.exited,
			])
			console.log(`\n# ${file}\n${out}${err}`.trimEnd())
			return code ? [file] : []
		}),
	)
).flat()
const took = `${((performance.now() - started) / 1000).toFixed(1)}s`
console.log(
	failed.length
		? `\n${failed.length} of ${files.length} failed in ${took}: ${failed.join(', ')}`
		: `\nall ${files.length} ok in ${took}`,
)
process.exit(failed.length ? 1 : 0)
