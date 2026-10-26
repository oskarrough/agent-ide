// An agent reads what pi would read in its folder: the AGENTS.md files and the skills, found on its runner. An edit
// counts from the next request. MODULES=-context leaves them out.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	conversationOf,
	db,
	dir,
	done,
	runner,
	server,
	sleep,
	view,
} from './lib.js'

writeFileSync(path.join(dir, 'AGENTS.md'), 'Always answer in French.')
mkdirSync(path.join(dir, '.agents/skills/greet'), { recursive: true })
writeFileSync(
	path.join(dir, '.agents/skills/greet/SKILL.md'),
	'---\nname: greet\ndescription: Greet someone warmly.\n---\nSay bonjour.',
)

// The prompt as the agent's conversation holds it: every system message's text, in order.
const prompt = async (id) =>
	JSON.stringify(
		(await conversationOf(await view(id), 'echo/echo@laptop')).entries.filter(
			(e) => e.kind === 'pi.system',
		),
	)
const ask = async (id, body, n) => {
	await api('POST', `/api/threads/${id}/entries`, {
		body,
		to: { runner: 'laptop', model: 'echo/echo' },
	})
	await answered(id, n)
}

let srv = await server()
let laptop = await runner('laptop')
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'context' })
await ask(id, 'hello', 1)
const first = await prompt(id)
check(
	first.includes('Always answer in French.') && first.includes('AGENTS.md'),
	"the folder's AGENTS.md is in the prompt",
	first.slice(0, 400),
)
check(
	first.includes('<name>greet</name>') && first.includes('Greet someone warmly.'),
	'its skills are listed by name and description',
)
check(!first.includes('Say bonjour.'), "a skill's body is not; the agent reads it when it needs it")

writeFileSync(path.join(dir, 'AGENTS.md'), 'Always answer in Danish.')
await ask(id, 'again', 2)
const second = await prompt(id)
check(second.includes('Always answer in Danish.'), 'an edit counts from the next request')

srv.kill()
laptop.kill()
await sleep(300)
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
srv = await server({ MODULES: '-context' })
laptop = await runner('laptop')
const {
	json: { id: off },
} = await api('POST', '/api/threads', { title: 'no context' })
await ask(off, 'hello', 1)
check(!(await prompt(off)).includes('Always answer'), 'MODULES=-context: no AGENTS.md in the prompt')
done()
