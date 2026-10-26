// MODULES=+search gives agents `web_search`: Exa's free search, which needs no key and is rate limited. Enough to find pages;
// an agent reads one whole with curl. SEARCH_URL points it at anything else that answers Exa's MCP call.
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'

const url = process.env.SEARCH_URL || 'https://mcp.exa.ai/mcp?tools=web_search_exa'

export function server() {
	const search = defineTool({
		name: 'web_search',
		description:
			"Search the web. Answers with each page's title, address and highlights; read a page whole with curl.",
		parameters: Type.Object({
			query: Type.String(),
			results: Type.Optional(
				Type.Number({ description: 'How many pages, 5 by default, at most 10' }),
			),
		}),
		replay: 'safe',
		execute: async ({ query, results = 5 }, api, context) => {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'web_search_exa',
						arguments: { query, numResults: Math.min(results, 10) },
					},
				}),
				signal: context.abortSignal,
			})
			if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`.slice(0, 500))
			// Plain JSON, or a stream of events whose last data line holds the answer.
			const raw = await res.text()
			const reply = JSON.parse(
				raw.includes('data:')
					? raw
							.split('\n')
							.findLast((l) => l.startsWith('data:'))
							.slice(5)
					: raw,
			)
			if (reply.error || reply.result?.isError)
				throw new Error(reply.error?.message ?? reply.result.content?.[0]?.text ?? 'search failed')
			const text = (reply.result?.content ?? [])
				.map((part) => part.text ?? '')
				.join('\n')
				.slice(0, 30000)
			return { output: [{ type: 'text', text: text || 'Nothing found.' }] }
		},
	})
	return { extension: defineExtension({ name: 'agent-ide.search', tools: [search] }) }
}
