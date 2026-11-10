/** Polishes a default thread title once after its first answer, leaving chosen titles alone. On by default; MODULES=-auto-title turns it off.
 * `POST /api/threads/:id/auto-title` writes a new one on request, whatever the title is, and answers once it's written; a rename meanwhile wins.
 * `auto-title.model` in agent-ide.json selects a model:thinking, optionally @runner; the default is
 * the thread agent's own model and runner with thinking off (or the answering bot's with no thread agent). Failed attempts are logged, never retried.
 */
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { messageText } from '../remote.js'
import { AGENT, agentTo, background, finished } from '../util.js'
import { defaultTitle } from '../apps/client/title.js'

export const on = true

const SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help someone recognize this conversation in a list weeks later.
Your output must be a single line, at most 36 characters, with no explanation.
</task>

<rules>
- Use the same language as the conversation you are titling
- Silently reduce the conversation, weighting its newest messages, to its subject (what is this about?) and outcome (what does the person want?); title those and drop incidental instructions such as "hey", "can someone", "please", or how the work should be done
- A compact noun phrase or a clear action phrase, 2–5 words where possible, grammatically natural — no word salad
- Start with a verb when the message asks for work (Fix, Add, Find); otherwise use a noun phrase
- Keep exact: names, technical terms, numbers, filenames, dates, and ticket IDs like ABC-123
- Remove: the, this, my, a, an
- Do not copy and truncate the message; do not claim the work is done
- No quotes, labels, markdown, or trailing punctuation
- Never answer the message or use tools; never say you cannot make a title
- Short or conversational messages ("hello", "lol", "what's up") get a title for the tone or intent (Greeting, Quick check-in, Light chat)
</rules>

<examples>
"can we ship the release on friday?" → Friday release
"hey so the deploy broke again" → Deploy breakage
"debug 500 errors in production" → Debugging production 500 errors
"how do I connect postgres to my API" → Postgres API connection
"@ada can you add refresh token support to auth" → Auth refresh token support
"hello!" → Greeting
</examples>`

/** The opening and the newest messages, each cut short, so a thread that moved on from "hey hey" is titled for where it is now */
function recent(messages) {
	const shown = messages.length > 7 ? [messages[0], ...messages.slice(-6)] : messages
	return shown
		.map((message) => `${message.data.author}: ${(message.data.body ?? '').trim().slice(0, 500)}`)
		.join('\n\n')
		.slice(0, 3000)
}

function sanitizeThreadTitle(raw) {
	const line = raw
		.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
		.split(/\r?\n/)
		.map((candidate) =>
			candidate
				.trim()
				.replace(/^```\w*|```$/g, '')
				.trim(),
		)
		.find((candidate) => candidate.length > 0)
	if (!line) return null
	const cleaned = line
		.replace(/^(?:title\s*:\s*)/i, '')
		.replace(/^['"`“”]+|['"`“”]+$/g, '')
		.replace(/[.!?…]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!cleaned) return null
	if (cleaned.length <= 36) return cleaned
	return `${cleaned.slice(0, 36 - 1).trimEnd()}…`
}

export function server(core) {
	const modelName = core.config?.['auto-title']?.model
	const Title = defineDoc({
		kind: 'agent-ide.auto-title',
		version: 1,
		scope: 'conversation',
		history: 'latest',
		fork: 'initial',
		checkpointWhen: () => true,
		initial: () => ({ scheduled: false }),
	})
	const AutoTitle = defineTask({
		name: 'agent-ide.auto-title',
		version: 1,
		initial: () => ({ phase: 'write' }),
		phases: {
			async write({ conversationId: threadId, input }, rt, ctx) {
				// Record the try before calling: resuming a task must not spend another completion.
				if (await rt.memo('attempted', ctx)) return rt.commit(() => finished(), ctx)
				await rt.memo('attempted', true, ctx)
				try {
					const messages = await core.messages(threadId)
					const opening = messages[0]?.data.body ?? ''
					const row = await core.thread(threadId)
					// Asked for again, it replaces the title it was asked to replace; otherwise only the default
					const expected = input.replaces ?? defaultTitle(opening)
					if (row.title !== expected)
						return rt.commit(() => finished('completed', { title: row.title }), ctx)
					const own = await core.agentOf(row.agents[AGENT]?.conversation ?? input.conversation)
					const choice = modelName
						? agentTo(modelName.includes('@') ? modelName : `${modelName}@${own.runner}`)
						: { runner: own.runner, model: own.model, thinkingLevel: 'off' }
					await core.runners.online(choice.runner, rt.signal)
					const to = await core.address(choice, false, rt.signal)
					const model = core.models.getModel(`runner:${to.runner}`, to.model)
					const reply = await core.models.completeSimple(
						model,
						{
							messages: [
								{ role: 'system', content: SYSTEM_PROMPT, timestamp: Date.now() },
								{
									role: 'user',
									content: `Title this conversation:\n\n${recent(messages)}`,
									timestamp: Date.now(),
								},
							],
						},
						{
							signal: rt.signal,
							...(to.thinkingLevel && to.thinkingLevel !== 'off'
								? { reasoning: to.thinkingLevel }
								: {}),
						},
					)
					if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
						throw new Error(reply.errorMessage ?? reply.stopReason)
					const title = sanitizeThreadTitle(messageText(reply))
					if (!title) throw new Error('model returned no usable title')
					return rt.commit(async (tx) => {
						return finished('completed', await core.setTitleIn(tx, threadId, title, expected))
					}, ctx)
				} catch (error) {
					if (rt.signal.aborted) throw error
					console.error(`auto-title: thread ${threadId}: ${error.message}`)
					return rt.commit(() => finished('completed', { error: error.message }), ctx)
				}
			},
		},
		abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})
	/** A new title on request, from the same model; it answers once the title is written, or with why it wasn't */
	async function serve(threadId, query, body) {
		if (threadId === undefined || body === undefined)
			throw new Error('POST /api/threads/:id/auto-title writes a new title')
		await core.conversation(threadId)
		const row = await core.thread(threadId)
		const conversation =
			row.agents[AGENT]?.conversation ?? Object.values(row.agents)[0]?.conversation
		if (!conversation) throw new Error('Nobody has answered here yet')
		const task = await core.commit((tx) =>
			tx.createTask(AutoTitle, { conversation, replaces: row.title }, background(threadId)),
		)
		const { result } = (await core.waitForTask(task)).state.outcome
		if (result?.error) throw new Error(result.error)
		return { title: result?.title ?? row.title }
	}
	return {
		serve,
		extension: defineExtension({ name: 'agent-ide.auto-title', tasks: [AutoTitle] }),
		async posted(tx, threadId, entry) {
			if (!entry.data.answer) return
			const state = await tx.doc(Title, threadId)
			if (state.scheduled) return
			state.scheduled = true
			await tx.createTask(
				AutoTitle,
				{
					conversation: entry.data.answer.conversation,
				},
				background(threadId),
			)
		},
	}
}
