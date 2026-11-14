/** One answer each */
import {
	answers as answersOf,
	api,
	brief,
	call,
	check,
	done,
	quiet,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()

/** Ask once, then twice more while the child is still thinking: its first answer waits until both are in */
const posted = async (n) => {
	const kid = (await api('GET', '/api/threads')).json.find((t) => t.parent === parent)
	return kid && (await view(kid.id)).entries.filter((e) => e.data.from === parent).length >= n
}
const bot = await scriptedRunner('bot', async (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	const results = request.messages.filter((m) => m.role === 'toolResult')
	if (last.role === 'toolResult') {
		const child = Number(text(results[0]).match(/thread (\d+)/)?.[1])
		if (results.length === 1) return call('post', { thread: child, body: 'and another thing' })
		if (results.length === 2) return call('post', { thread: child, body: 'and a third' })
		return say('waiting')
	}
	if (t.includes(' answering>')) return say(`Got it: ${t.split('\n')[0]}`)
	if (t.includes('ask twice')) return call('post', { title: 'pair', body: 'slow question' })
	if (t.includes('slow question')) {
		await until(() => posted(3), 15000, 20)
		return say('thinking slowly')
	}
	if (t.includes('and another thing') || t.includes('and a third'))
		return say('one answer for that')
	return say(`heard: ${t}`)
})

const {
	json: { id: parent },
} = await api('POST', '/api/threads', { title: 'dup' })
await api('POST', `/api/threads/${parent}/entries`, {
	body: 'ask twice',
	to: { runner: 'bot', model: 'echo/echo' },
})
const settled = await until(async () => {
	const v = await view(parent)
	return answersOf(v).some((e) => e.data.body.includes('Got it')) && v.status !== 'working'
		? v
		: null
}, 30000)
await quiet()

const p = await view(parent)
const child = (await api('GET', '/api/threads')).json.find((t) => t.parent === parent)
const kid = child && (await view(child.id))
const posts = kid?.entries.filter((e) => e.data.from === parent) ?? []
const answers = kid ? answersOf(kid) : []
const replies = p.entries.filter((e) => e.data.from === child?.id && e.data.re)
console.log('answers in the child reply to:', JSON.stringify(answers.map((a) => a.data.re)))
console.log(
	'replies in the parent:',
	JSON.stringify(replies.map((r) => ({ re: r.data.re, body: r.data.body.slice(0, 30) }))),
)
check(Boolean(settled), 'the parent heard back')
check(posts.length === 3, 'three posts in the child', kid && brief(kid))
const want = answers.map((a) => (a.data.re ?? []).join(',')).sort()
const got = replies.map((r) => r.data.re.join(',')).sort()
check(
	JSON.stringify(want) === JSON.stringify(got),
	'one reply per child answer, re = the posts it answers',
	`want ${JSON.stringify(want)} got ${JSON.stringify(got)}`,
)
check(
	JSON.stringify(want) === JSON.stringify(posts.map((post) => String(post.id)).sort()),
	'each post, even those that came in while the child was thinking, gets an answer of its own',
	JSON.stringify(want),
)

bot.close()
done()
