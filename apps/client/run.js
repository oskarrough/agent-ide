/** An agent's turns, read from its own conversation: each one line in the thread, opened into every step it took */
import html from '@solidjs/html'
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	createStore,
	For,
	onSettled,
	Show,
} from 'solid-js'
import { entries, homeBot, threads, titleOf } from './server.js'
import { Cross } from './thread.js'
import { authorLabel, doing, messageText, touched } from './agent.js'
import { Dot } from './dot.js'

/**
 * A turn's line. While its agent works, the step it's in now, and below it the last few steps and the words coming in;
 * when the turn ends, its summary. Open, every step in order.
 */
export function Turn(props) {
	const live = () => props.live && doing[props.thread]?.[props.agent.conversation]
	const [open, setOpen] = createSignal(false)
	createEffect(
		() => props.live,
		(on) => (on ? tick() : undefined),
	)
	/** Its steps, the handed one as what it adds to the thread: nothing for the one message above, else a count that opens onto them */
	const steps = createMemo(() => {
		const all = props.turn?.steps ?? []
		if (all[0]?.label !== 'handed') return all
		const step = handedStep(all[0], props.thread, entries[props.thread] ?? [])
		return step ? [step, ...all.slice(1)] : all.slice(1)
	})
	const now = () => {
		const running = steps().findLast((step) => step.name && !step.result)
		if (running)
			return running.name === 'post'
				? `asking ${askedThread(running) ? titleOf(askedThread(running)) : (running.args.title ?? 'a new thread')}`
				: `${running.name}(${argsLine(running)})`
		if (props.agent.status === 'blocked')
			return `waiting for ${props.agent.to?.runner ?? 'its runner'} to come online`
		return messageText(live()?.message) ? 'writing' : 'thinking'
	}
	const calls = () => steps().filter((step) => step.name)
	/** A closed turn's summary, worked out when its steps change; an equal string updates nothing */
	const summed = createMemo(() => (props.live ? '' : summary({ ...props.turn, steps: steps() })))
	const line = () => {
		if (!props.live) return summed()
		const start = props.turn?.start
		return [
			now(),
			calls().length && plural(calls().length, 'step'),
			start && clock() - start >= 1000 && seconds(clock() - start),
		]
			.filter(Boolean)
			.join(' · ')
	}
	const said = () => messageText(live()?.message)
	return html`
		<li class=${() => ({ turn: true, live: !!props.live })}>
			<details onToggle=${(event) => setOpen(event.currentTarget.open)}>
				<summary>
					<small>
						<${Show} when=${() => props.live}><${Dot} state=${() => props.agent.status} /><//>
						<${Show} when=${() => props.above !== props.agent.name}
							><span>${() => authorLabel(props.agent.name)}</span>${' · '}<//
						><span class="now">${line}</span>
					</small>
				</summary>
				<${Show} when=${open}>
					<ol class="steps" style=${() => `--label: ${labelWidth(steps())}ch`}>
						<${For} each=${steps} keyed=${(step) => step.key}
							>${(step) => html`<${Step} step=${() => step()} />`}<//
						>
						<${Show} when=${said}><li class="said">${said}</li><//>
					</ol>
				<//>
			</details>
		</li>
	`
}

/**
 * A post, from the thread that sent it: the message as a sent step, with the asked thread's dot hanging beside it while
 * it works, then the answer as a received one when it comes.
 */
export function Exchange(props) {
	const asked = () => askedThread(props.step)
	const who = () =>
		props.answer?.data.author ??
		homeBot(asked())?.name ??
		threads.find((thread) => thread.id === asked())?.agents?.[0]?.name ??
		props.step.args.to ??
		''
	const took = () => {
		const start = props.step.result?.time
		const end = props.back
		return start && end && end - start >= 1000 ? seconds(end - start) : ''
	}
	const working = () =>
		!props.answer && threads.find((thread) => thread.id === asked())?.status === 'working'

	return html`
		<li class=${() => ({ exchange: true, handed: litIn(props.thread, props.answer?.id) })}>
			<span class="lead"
				><${Show} when=${working}><${Dot} state="working" title="Working on it" /><//
			></span>
			<ol class="steps">
				<${Cross}
					sent=${true}
					author=${who}
					thread=${asked}
					data=${() => ({ ...props.step.args, author: props.agent?.name })}
				/>
				<${Show} when=${() => props.answer}>
					<${Cross}
						author=${who}
						thread=${asked}
						data=${() => props.answer.data}
						title=${() => (took() ? `answered in ${took()}` : undefined)}
					/>
				<//>
			</ol>
		</li>
	`
}

function Step(props) {
	return html`
		<${Show}
			when=${() => props.step.name || props.step.label}
			fallback=${() => html`<li class="said">${() => props.step.said}</li>`}
		>
			<${Call} step=${() => props.step} />
		<//>
	`
}

/** The widest label among a turn's steps, so their inputs start at one column */
const labelWidth = (steps) =>
	Math.max(...steps.map((step) => (step.name ?? step.label ?? '').length))

function Call(props) {
	const result = () => props.step.result
	const [open, setOpen] = createSignal(false)
	const toggle = (on) => {
		setOpen(on)
		if (props.step.held) light(on ? props.step : null, props.step)
	}
	// Closed with its turn, it lets go of what it lit
	onSettled(() => () => props.step.held && light(null, props.step))
	return html`
		<li
			class=${() =>
				props.step.name
					? { call: true, failed: result()?.error, running: !result() }
					: `call told ${props.step.label}`}
		>
			<details onToggle=${(event) => toggle(event.currentTarget.open)}>
				<summary>
					<span class="tool">${() => props.step.name ?? props.step.label}</span>
					<span class="in">${() => input(props.step)}</span>
				</summary>
				<${Show} when=${open}>
					<div class="whole">
						<${Show} when=${() => props.step.name || props.step.text}>
							<pre>
${() => (props.step.name ? JSON.stringify(props.step.args, null, 2) : props.step.text)}</pre>
						<//>
						<${Show} when=${() => result()?.text}><pre>${() => result().text}</pre><//>
					</div>
				<//>
			</details>
		</li>
	`
}

const input = (step) => (step.name ? JSON.stringify(step.args) : (step.in ?? step.text ?? ''))

/** The messages an opened handed step lights where they are in the thread */
const [lit, setLit] = createRoot(() => createSignal(null))
/** Lights a step's messages, or with `null` puts out what `step` lit */
const light = (on, step) =>
	setLit((now) =>
		on
			? { thread: on.thread, ids: new Set(on.held), step: on.key }
			: now?.step === step.key
				? null
				: now,
	)
export const litIn = (thread, id) => lit()?.thread === thread && !!lit()?.ids.has(id)

/** What a delivery carried that the thread doesn't show: a note that the agent moved, and memory's lines for what didn't fit */
const unseenIn = (text) =>
	[
		[/^\[You now run as [^\n]*\]/, 'a note'],
		[/<chat>\n[\s\S]*?\n<\/chat>/, 'memory lines'],
	].flatMap(([pattern, word]) => {
		const found = text.match(pattern)
		return found ? [{ word, text: found[0] }] : []
	})

/**
 * A turn's handed step as the thread sees it: none when it was handed just the one message above it, else a count of
 * the messages and a reply from each thread that answered, and only the words the thread doesn't show.
 */
function handedStep(step, thread, messages) {
	const byId = new Map(messages.map((entry) => [entry.id, entry]))
	const held = step.held.map((id) => byId.get(id) ?? { id, data: {} })
	const replies = held.filter((entry) => entry.data.from && entry.data.re)
	const said = held.length - replies.length
	const unseen = unseenIn(step.text ?? '')
	if (said === 1 && !replies.length && !unseen.length) return null
	return {
		...step,
		thread,
		in: [
			said && plural(said, 'message'),
			...replies.map((entry) => `a reply from ${titleOf(entry.data.from)}`),
			...unseen.map((part) => part.word),
		]
			.filter(Boolean)
			.join(' + '),
		text: unseen.map((part) => part.text).join('\n\n'),
	}
}

/** What a turn did, in a few words; its asks have their own lines */
function summary(turn) {
	const tools = turn.steps.filter((step) => step.name)
	const edited = [
		...new Set(
			tools
				.filter(
					(step) => ['edit', 'write'].includes(step.name) && step.result && !step.result.error,
				)
				.map((step) => step.args.path?.split('/').pop()),
		),
	].filter(Boolean)
	const commands = tools.filter((step) => step.name === 'bash').length
	const posts = (word, list) =>
		list.length && `${word} ${list.map((step) => titleOf(askedThread(step))).join(', ')}`
	const parts = [
		edited.length && `edited ${edited.join(', ')}`,
		commands && plural(commands, 'command'),
		posts(
			'answered',
			tools.filter((step) => step.name === 'post' && answered(step)),
		),
		tools.length && plural(tools.length, 'step'),
		turn.end - turn.start >= 1000 && seconds(turn.end - turn.start),
	]
	// A turn with no call only thought, before its answer or instead of one
	return parts.filter(Boolean).join(' · ') || 'thought'
}

/** A step's arguments in one line, what it touches first */
const argsLine = ({ name, args }) =>
	name === 'post'
		? args.thread
			? `#${args.thread}`
			: (args.title ?? '')
		: (touched(args) ?? JSON.stringify(args)).split('\n')[0]

/** A post's ask: the thread it went to, or for an answer, the thread it answered */
const askedThread = (step) => step.result?.details?.thread ?? step.args.thread
const answered = (step) => /^Answered /.test(step.result?.text ?? '')

const seconds = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One clock for every live turn, ticking only while one is on screen */
const [clock, setClock] = createRoot(() => createSignal(Date.now()))
let ticking = 0,
	timer
const tick = () => {
	if (!ticking++) timer = setInterval(() => setClock(Date.now()), 1000)
	return () => --ticking || clearInterval(timer)
}

/**
 * Each agent conversation on screen, its entries as Pi keeps them.
 * Entries never change once written, so the store is shallow: a read tracks the conversation, not each entry's fields.
 */
const [conversations, setConversations] = createRoot(() => createStore({}, { shallow: true }))

export { conversations }

/** Takes an agent's entries off the socket: whole on each new watch, then each one once, as it's written */
export function heard(conversation, entries, whole) {
	const shown = entries.filter((entry) => entry.kind !== 'pi.system')
	setConversations((all) => {
		all[conversation] = whole || !all[conversation] ? shown : [...all[conversation], ...shown]
	})
}

/** A delivery's words, whether Pi kept them as a string or as blocks beside images */
const handedText = (message) =>
	typeof message?.content === 'string' ? message.content : messageText(message)

/**
 * Where an agent's newest compaction cuts, as the thread's message ids: the first message of the first delivery the agent still reads whole.
 * Older compactions are history the agent no longer reads, so they don't show. `memory` is whether the summary is the thread's memory lines, or Pi's own.
 */
export function cutsOf(conversation) {
	const all = conversations[conversation] ?? []
	return all
		.filter((entry) => entry.kind === 'pi.compaction')
		.slice(-1)
		.flatMap((entry) => {
			const kept = all.find(
				(other) => other.kind === 'agent-ide.delivery' && other.id >= entry.head,
			)
			const first = Math.min(...(kept?.data?.held ?? []))
			if (!Number.isFinite(first)) return []
			const summary = messageText(entry.model?.[0]) || ''
			// With memory the summary is its lines, `id+n|text`; otherwise it is Pi's own text
			const lines = [...summary.matchAll(/^(\d+)\+(\d+)\|(.*)$/gm)].map((line) => ({
				key: `${conversation}:${line[1]}+${line[2]}`,
				at: Number(line[1]),
				n: Number(line[2]),
				text: line[3],
			}))
			return [
				{
					key: `${conversation}:cut:${entry.id}`,
					id: entry.id,
					at: first - 0.5,
					memory: lines.length > 0,
					lines: lines.length
						? lines
						: [{ key: `${conversation}:summary:${entry.id}`, at: 0, n: first, text: summary }],
				},
			]
		})
}

/** A conversation cut into turns: each begins with a delivery and holds the calls, results and words that follow it */
export function turnsOf(conversation) {
	const turns = []
	for (const entry of conversations[conversation] ?? []) {
		const message = entry.model?.[0]
		if (entry.kind === 'agent-ide.delivery') {
			turns.push({
				key: `${conversation}:${entry.id}`,
				delivery: entry.id,
				held: entry.data?.held ?? [],
				after: Math.max(0, ...(entry.data?.held ?? [])),
				start: message?.timestamp,
				end: message?.timestamp,
				steps: [
					{
						key: `${entry.id}:handed`,
						label: 'handed',
						text: handedText(message),
						held: entry.data?.held ?? [],
					},
				],
			})
			continue
		}
		const turn = turns.at(-1)
		if (!turn || !message) continue
		turn.end = message.timestamp ?? turn.end
		if (message.role === 'assistant') {
			for (const block of message.content ?? []) {
				if (block.type === 'toolCall')
					turn.steps.push({
						key: block.id,
						name: block.name,
						args: block.arguments ?? {},
						result: null,
					})
				else if (block.type === 'thinking' && block.thinking?.trim())
					turn.steps.push({
						key: `${entry.id}:thought:${turn.steps.length}`,
						label: 'thought',
						text: block.thinking,
					})
				// The last words are the answer, which the thread shows itself
				else if (block.type === 'text' && block.text.trim() && message.stopReason === 'toolUse')
					turn.steps.push({ key: `${entry.id}:said`, said: block.text })
			}
		}
		if (message.role === 'toolResult') {
			const step = turn.steps.find((step) => step.key === message.toolCallId)
			if (step)
				step.result = {
					at: entry.id,
					time: message.timestamp,
					text: messageText(message),
					error: message.isError,
					details: message.details,
				}
		}
	}
	return turns
}

export const newestCut = (cuts) =>
	cuts.reduce((best, cut) => (!best || cut.id > best.id ? cut : best), null)

/** The posts a turn made that ask another thread, rather than answer one */
export const asksOf = (steps) =>
	steps.filter(
		(step) => step.name === 'post' && !step.result?.error && !answered(step) && askedThread(step),
	)

/** Each post's answer, looked up by the thread it asked instead of scanning every message per post */
export function answersIn(messages) {
	const byThread = new Map()
	for (const entry of messages)
		if (entry.data.from && entry.data.re)
			byThread.set(entry.data.from, [...(byThread.get(entry.data.from) ?? []), entry])
	return (step) =>
		step.name === 'post' &&
		step.result &&
		!step.result.error &&
		!answered(step) &&
		byThread.get(askedThread(step))?.find((entry) => entry.id > step.result.at)
}
