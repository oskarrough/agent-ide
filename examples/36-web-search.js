// MODULES=+search gives agents `web_search`. Off by default, the model isn't offered it. Here a stand-in answers the way Exa does.
import http from 'node:http'
import { rmSync } from 'node:fs'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { answered, api, call, check, db, done, say, scriptedRunner, server, text } from './lib.js'

const asked = []
const exa = http
	.createServer(async (req, res) => {
		let body = ''
		for await (const chunk of req) body += chunk
		asked.push(JSON.parse(body).params.arguments)
		const reply = {
			result: {
				content: [
					{
						type: 'text',
						text: 'Title: Pi Durable | Earendil\nURL: https://earendil.com/posts/pi-durable/\nHighlights: built for long-running agents',
					},
				],
			},
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' })
		res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
	})
	.listen(0)
const SEARCH_URL = `http://127.0.0.1:${exa.address().port}/mcp`

let offered = []
const route = (request) => {
	offered = getCurrentTools(request.messages).map((t) => t.name)
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(`found: ${text(last)}`)
	return offered.includes('web_search')
		? call('web_search', { query: 'pi durable' })
		: say('no search here')
}

async function round(env) {
	for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
	const srv = await server(env)
	const bot = await scriptedRunner('bot', route)
	const {
		json: { id },
	} = await api('POST', '/api/threads', { title: 'search' })
	await api('POST', `/api/threads/${id}/entries`, {
		body: 'look it up',
		to: { runner: 'bot', model: 'echo/echo' },
	})
	const answer = (await answered(id))?.entries.at(-1).data.body ?? ''
	bot.close()
	srv.kill()
	await new Promise((r) => srv.on('exit', r))
	return { answer, offered }
}

const off = await round({})
check(
	!off.offered.includes('web_search'),
	'by default agents have no web_search',
	JSON.stringify(off.offered),
)
const on = await round({ MODULES: '+search', SEARCH_URL })
check(on.offered.includes('web_search'), 'MODULES=+search offers it')
check(
	asked[0]?.query === 'pi durable' && on.answer.includes('https://earendil.com/posts/pi-durable/'),
	'a search goes out, and the agent reads the pages it found',
	on.answer,
)
exa.close()
done()
