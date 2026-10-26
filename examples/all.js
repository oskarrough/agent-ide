// Every example, as many at once as there are cores, each with its own server, port and store; each one's output shows whole when it ends.
// All at once starves a small machine, and servers miss the examples' waits. The real-model examples spend tokens, so they only run with REAL=1.
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'

const files = readdirSync(import.meta.dirname)
	.filter((f) => /^\d\d-.*\.js$/.test(f) && (process.env.REAL || !f.includes('real-model')))
	.sort()
const run = (file) =>
	new Promise((resolve) =>
		execFile(process.execPath, [`${import.meta.dirname}/${file}`], { maxBuffer: 1e8 }, (e, out, err) => {
			console.log(`\n# ${file}\n${out}${err}`.trimEnd())
			resolve(e ? [file] : [])
		}),
	)
const queue = [...files]
const started = performance.now()
const failed = (
	await Promise.all(
		Array.from({ length: availableParallelism() }, async () => {
			const mine = []
			for (let file; (file = queue.shift()); ) mine.push(...(await run(file)))
			return mine
		}),
	)
)
	.flat()
	.sort()
const took = `${((performance.now() - started) / 1000).toFixed(1)}s`
console.log(
	failed.length
		? `\n${failed.length} of ${files.length} failed in ${took}: ${failed.join(', ')}`
		: `\nall ${files.length} ok in ${took}`,
)
process.exit(failed.length ? 1 : 0)
