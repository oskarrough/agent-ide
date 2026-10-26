import { wires } from './wires.js'
import './agent-memory.js'
const params = new URLSearchParams(location.search)
// The server that served this page, or another with ?server=.
const url =
	params.get('server') ||
	(location.protocol === 'file:' ? 'http://127.0.0.1:3000' : location.origin)
const me = params.get('user') || 'you'
const $ = (id) => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
	const e = Object.assign(document.createElement(tag), props)
	e.append(...children.filter((c) => c != null && c !== false))
	return e
}
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// One dot everywhere: grey when there's nothing, green when it's on, pulsing green while it works, amber when it's blocked.
const light = (state) =>
	`dot${state === 'on' ? ' on' : state === 'working' ? ' working' : ['blocked', 'parked'].includes(state) ? ' blocked' : ''}`

// Where the four pieces live, per product. The chips move between the places; hovering one lights it up on the stage.
const PIECES = {
	model: 'Claude, GPT, Gemini',
	loop: 'Pi, Claude Code, Codex',
	hands: 'where tools run',
	memory: 'the chat history',
}
const PRODUCTS = {
	chatgpt: {
		model: 'lab',
		loop: 'lab',
		hands: 'lab',
		memory: 'lab',
		caption: "All of it runs at OpenAI, so there's nothing to set up and none of it is yours.",
	},
	'claude-code': {
		model: 'lab',
		loop: 'laptop',
		hands: 'laptop',
		memory: 'laptop',
		caption: 'Everything but the model runs on your laptop, so it stops when you close the lid.',
	},
	'agent-ide': {
		model: 'lab',
		loop: 'server',
		hands: 'anywhere',
		memory: 'server',
		caption:
			'The loop and the memory live on a box that stays on, and the hands on whichever computer you lend it.',
	},
}
const chips = Object.fromEntries(
	Object.entries(PIECES).map(([piece, hint]) => [
		piece,
		el('span', {
			className: 'chip',
			title: hint,
			textContent: piece[0].toUpperCase() + piece.slice(1),
		}),
	]),
)
for (const [piece, chip] of Object.entries(chips)) {
	chip.onmouseenter = () => {
		$('stage').dataset.focus = piece
	}
	chip.onmouseleave = () => {
		$('stage').dataset.focus = seen
	}
}
function product(name) {
	const before = new Map(Object.values(chips).map((c) => [c, c.getBoundingClientRect()]))
	for (const [piece, place] of Object.entries(PRODUCTS[name]).filter(([k]) => k in PIECES))
		document.querySelector(`[data-place=${place}]`).append(chips[piece])
	for (const place of document.querySelectorAll('.place'))
		place.classList.toggle('used', place.querySelector('.chip') !== null)
	// Each chip glides from where it was.
	for (const [chip, was] of before) {
		const now = chip.getBoundingClientRect()
		if (was.width)
			chip.animate(
				[
					{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` },
					{ transform: 'none' },
				],
				{ duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' },
			)
	}
	for (const b of document.querySelectorAll('[data-product]'))
		b.setAttribute('aria-pressed', b.dataset.product === name)
	$('caption').textContent = PRODUCTS[name].caption
}
for (const b of document.querySelectorAll('[data-product]'))
	b.onclick = () => product(b.dataset.product)
product('chatgpt')

// The section in view says what the stage should show.
let seen = 'all'
const sections = new IntersectionObserver(
	(list) => {
		for (const e of list)
			if (e.isIntersecting) $('stage').dataset.focus = seen = e.target.dataset.focus
	},
	{ rootMargin: '-45% 0px -45% 0px' },
)
document.querySelectorAll('.page > section').forEach((s) => sections.observe(s))

// model:thinking@runner, as pi names a model: the last @ splits off the runner, a last :thinkingLevel the thinking.
// name=model@runner names the agent it makes; a name alone is that agent in this thread.
function agent(text) {
	const there = threads.find((t) => t.id === current)?.agents.find((a) => a.name === text)
	if (there?.to) return there.to
	if (bots.some((b) => b.name === text)) return { name: text }
	const eq = text.indexOf('='),
		name = text.slice(eq + 1)
	const at = name.lastIndexOf('@')
	let model = at < 0 ? name : name.slice(0, at),
		thinkingLevel
	const colon = model.lastIndexOf(':')
	if (colon >= 0 && EFFORTS.includes(model.slice(colon + 1)))
		[model, thinkingLevel] = [model.slice(0, colon), model.slice(colon + 1)]
	return {
		runner: at < 0 ? '' : name.slice(at + 1),
		...(model && { model }),
		...(thinkingLevel && { thinkingLevel }),
		...(eq > 0 && { name: text.slice(0, eq) }),
	}
}
const name = ({ model, thinkingLevel, runner, name: called }) =>
	!runner && called
		? called
		: `${called ? `${called}=` : ''}${model ?? ''}${thinkingLevel ? `:${thinkingLevel}` : ''}@${runner}`
// An agent's row on its runner's card: its name there, model@runner unless it was given another.
const slot = ({ runner, model, name }) => `${name ?? model}@${runner}`
const same = (a, b) => a?.runner === b?.runner && a?.model === b?.model && a?.name === b?.name

let up = false,
	runners = [],
	threads = [],
	botsOn = false,
	bots = [] // with the bots module: each bot's name, home thread, recipe and instructions
let current = Number(params.get('thread')) || null
let picks = [] // whom the next message asks, the same as the text under the composer
const details = new Map() // thread id → its entries
const people = new Map() // thread id → who wrote or read there
const live = new Map() // `${thread} ${agent}` → what that agent is doing right now

const api = (path, body) =>
	fetch(
		url + path,
		body === undefined
			? {}
			: {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-user': me },
					body: JSON.stringify(body),
				},
	).then(async (r) => {
		const json = await r.json()
		if (!r.ok) throw new Error(json.error)
		return json
	})

// The thread on screen and its family: what it forked from, the threads its agents started, and theirs.
function family() {
	if (!current) return []
	const byId = new Map(threads.map((t) => [t.id, t]))
	const up = (id) => byId.get(id)?.parent ?? forkOf(byId.get(id))
	let root = current
	for (let n = 0; up(root) && byId.has(up(root)) && n < 20; n++) root = up(root)
	const out = [root]
	for (let i = 0; i < out.length; i++)
		for (const t of threads)
			if (up(t.id) === out[i] && !out.includes(t.id) && !t.hidden) out.push(t.id)
	if (!out.includes(current)) out.push(current)
	return out.filter((id) => byId.has(id))
}
// Pi records where a fork came from.
// Just the chat, or the chat beside the story; the link remembers which.
const setMode = (chat) => {
	document.body.classList.toggle('chat', chat)
	$('mode').textContent = chat ? 'With the story' : 'Just the chat'
	const next = new URL(location.href)
	if (chat) next.searchParams.set('chat', '')
	else next.searchParams.delete('chat')
	history.replaceState(null, '', next)
	dispatchEvent(new Event('resize'))
}
$('mode').onclick = () => setMode(!document.body.classList.contains('chat'))
setMode(params.has('chat'))
// On a phone: one drawer open at a time, all threads on the left or this thread's family on the right.
const phone = matchMedia('(max-width: 700px)')
const sheet = (name) => {
	document.body.classList.toggle('list', name === 'list')
	document.body.classList.toggle('side', name === 'side')
}
$('back').onclick = () => sheet('list')
$('pill').onclick = () => sheet('side')
$('scrim').onclick = () => sheet(null)
addEventListener('keydown', (e) => {
	if (e.key === 'Escape') sheet(null)
})
phone.addEventListener('change', () => {
	sheet(null)
	render()
})
const forkOf = (t) => t?.conversation?.parent?.conversationId
const go = (id) => {
	current = id
	sheet(null)
	const next = new URL(location.href)
	if (id) next.searchParams.set('thread', id)
	else next.searchParams.delete('thread')
	history.replaceState(null, '', next)
	focus = true
	// A bot's home asks the bot; leaving it gives back whom you asked before.
	if (botAt(id)) {
		beforeHome ??= picks
		choose([{ name: botAt(id).name }])
	} else if (beforeHome) {
		choose(beforeHome)
		beforeHome = null
	}
	refresh()
}
let beforeHome = null // whom the composer asked before a bot's home took it over
let focus = false // the next render puts the cursor in the composer
// Hides it; Pi keeps everything.
async function remove(id) {
	await fetch(`${url}/api/threads/${id}`, { method: 'DELETE', headers: { 'x-user': me } })
	if (family().includes(id)) go(null)
	else refresh()
}

// A thread's tools, as `pi --tools` takes them. Hands off is the common case: its agents read and ask others.
const HANDS_OFF = ['-write', '-edit', '-bash']
let fresh_tools = null // what a new thread starts with
const parseTools = (text) => text.split(/[\s,]+/).filter(Boolean)
// A toggle and the tools it stands for, kept in step; either one sets them.
function handsControl(tools, set) {
	const box = el('div', { className: 'hands' })
	const toggle = el('button', {
		type: 'button',
		textContent: 'hands off',
		title: 'Its agents read and ask others, and change nothing themselves',
	})
	const field = el('input', {
		placeholder: 'every tool',
		spellcheck: false,
		title: 'tools, as pi --tools takes them: read,post or -write,-edit,-bash',
	})
	const show = (list) => {
		toggle.setAttribute('aria-pressed', Boolean(list))
		if (document.activeElement !== field) field.value = (list ?? []).join(',')
	}
	const apply = async (list) => {
		field.classList.remove('bad')
		try {
			await set(list?.length ? list : null)
		} catch (error) {
			field.classList.add('bad')
			field.title = error.message
		}
	}
	toggle.onclick = (e) => {
		e.stopPropagation()
		apply(toggle.getAttribute('aria-pressed') === 'true' ? null : HANDS_OFF)
	}
	field.onchange = () => apply(parseTools(field.value))
	field.onkeydown = (e) => {
		if (e.key === 'Enter') field.blur()
	}
	box.append(toggle, field)
	box.show = show
	show(tools)
	return box
}
// The thread's sheet holds its hands, for the thread on screen or the one about to start.
const sideHands = handsControl(null, async (tools) => {
	if (current) return api(`/api/threads/${current}/tools`, { tools }).then(refresh)
	fresh_tools = tools
	blankBox?.classList.toggle('hands-off', Boolean(tools))
	sideHands.show(tools)
})
$('side').append(el('h3', { textContent: 'Tools' }), sideHands)
// At a bot's home, the sheet is the bot's: its instructions, the model it joins threads with, where else it is.
const botSheet = el(
	'div',
	{ className: 'bot', hidden: true },
	el('h3', { textContent: 'Soul' }),
	el('textarea', {
		className: 'soul',
		rows: 8,
		placeholder: 'Who it is. It writes this itself as you talk, or you can.',
		onchange: (e) => saveBot({ name: botAt(current).name, instructions: e.target.value }),
	}),
	el('h3', { textContent: 'Model' }),
	el(
		'button',
		{
			type: 'button',
			className: 'pick',
			title: 'The model it joins new threads with',
			onclick: () => {
				recipeFor = botAt(current).name
				$picker.showPopover()
			},
		},
		el('span', { className: light('on') }),
		el('span'),
	),
	el('h3', { textContent: 'Also in' }),
	el('ul', { className: 'thread-family' }),
	el('button', {
		type: 'button',
		className: 'forget',
		textContent: 'Forget this bot',
		title: 'Every thread stays; agents of its name stop reading its soul',
		onclick: async () => {
			await fetch(`${url}/api/bots/${botAt(current).name}`, {
				method: 'DELETE',
				headers: { 'x-user': me },
			})
			refresh()
		},
	}),
)
$('side').append(botSheet)
function sheetFor(bot) {
	botSheet.hidden = !bot
	if (!bot) return
	const soul = botSheet.querySelector('.soul')
	if (document.activeElement !== soul) soul.value = bot.instructions
	botSheet.querySelector('.pick').lastChild.textContent = short(bot.to)
	botSheet
		.querySelector('ul')
		.replaceChildren(
			...threads
				.filter((t) => t.id !== bot.home && !t.hidden && t.agents.some((a) => a.name === bot.name))
				.map((t) => threadRow(t)),
		)
}
// A thread's name opens its sheet in the chat, and writes in it on the page with the story.
const header = (id) => () =>
	current !== id
		? go(id)
		: document.body.classList.contains('chat')
			? sheet('side')
			: form.querySelector('input').focus()

async function ask(body, to = picks) {
	if (!to.length) return
	if (!current) {
		const { id } = await api('/api/threads', {
			title: body.slice(0, 60),
			...(fresh_tools ? { tools: fresh_tools } : {}),
		})
		fresh_tools = null
		go(id)
	}
	await api(`/api/threads/${current}/entries`, {
		body,
		to: to.map((p) => (p.runner ? p : p.name)),
	})
	refresh()
}

// The composer: what you write, and whom it asks as one editable name.
const composer = $('composer').content.cloneNode(true)
const form = composer.querySelector('form'),
	$to = composer.querySelector('#to')
form.onsubmit = async (e) => {
	e.preventDefault()
	const input = form.querySelector('input'),
		body = input.value
	input.value = ''
	await ask(body).catch((error) => {
		input.value = body
		alert(error.message)
	})
}
$to.oninput = () => {
	picks = $to.value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(agent)
	for (const { runner, ...set } of picks) if (runner) chosen[runner] = set
	render()
}
// Enter in the name line keeps the name; it doesn't send.
$to.onkeydown = (e) => {
	if (e.key === 'Enter') e.preventDefault()
}
const choose = (next) => {
	picks = next
	$to.value = picks.map(name).join(', ')
	render()
}

// The model picker: whom the next message asks, chosen where you write. One row per runner that's online.
const $pick = form.querySelector('.pick'),
	$picker = $('picker')
$picker.append($to)
const short = (p) =>
	!p.runner
		? p.name
		: `${(p.model ?? '').split('/').pop()}${p.thinkingLevel ? ` · ${p.thinkingLevel}` : ''} · ${p.runner}`
// A popover opens next to what opened it: above it on a big screen, as a sheet from the bottom on a phone.
function place(pop, from) {
	if (phone.matches) return void pop.removeAttribute('style')
	const r = from.getBoundingClientRect()
	Object.assign(pop.style, {
		left: `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`,
		top: 'auto',
		bottom: `${innerHeight - r.top + 6}px`,
	})
}
$pick.onclick = () => {
	$picker.togglePopover()
}
$picker.addEventListener('toggle', (e) => {
	$pick.ariaExpanded = String(e.newState === 'open')
	if (e.newState === 'open') {
		pickerRows()
		place($picker, recipeFor ? botSheet.querySelector('.pick') : $pick)
	}
})
function pickerRows() {
	const online = runners.filter((r) => r.online),
		several = online.length > 1
	const rows = online.map((r) => {
		const set = setting(r),
			on = picks.some((p) => p.runner === r.name)
		const models = [...new Set([set.model, r.model, ...(r.offers ?? [])].filter(Boolean))]
		// A model is a row: click to ask it here, shift-click to ask it too. Thinking is a row of steps; the lit one again goes back to default.
		const model = (o) =>
			el(
				'button',
				{
					type: 'button',
					className: `model${on && o === set.model ? ' on' : ''}`,
					onclick: (e) => {
						tune(r, { model: o })
						if (recipeFor) {
							const { thinkingLevel } = setting(r)
							saveBot({ name: recipeFor, to: { runner: r.name, model: o, ...(thinkingLevel && { thinkingLevel }) } })
							return $picker.hidePopover()
						}
						if (!on || !(e.shiftKey || picks.length > 1)) toggle(r, e.shiftKey)
						if (!e.shiftKey) $picker.hidePopover()
					},
				},
				el('span', { textContent: o.split('/').pop() }),
				el('small', { textContent: o.includes('/') ? o.split('/')[0] : '' }),
			)
		const step = (x) =>
			el('button', {
				type: 'button',
				textContent: { minimal: 'min', medium: 'med' }[x] ?? x,
				title: x,
				ariaPressed: String(set.thinkingLevel === x),
				onclick: () => tune(r, { thinkingLevel: set.thinkingLevel === x ? undefined : x }),
			})
		return el(
			'li',
			{ className: on ? 'on' : '' },
			el(
				'div',
				{ className: 'who' },
				el('span', { className: light('on') }),
				el('b', { textContent: r.name }),
				el('small', { textContent: r.dir, title: r.dir }),
				several &&
					el('button', {
						type: 'button',
						className: 'also',
						textContent: on ? 'asked' : 'ask too',
						ariaPressed: String(on),
						title: 'Ask it too',
						onclick: () => toggle(r, true),
					}),
			),
			el('div', { className: 'models' }, ...models.map(model)),
			el('h4', { textContent: 'Thinking' }),
			el('div', { className: 'steps' }, ...EFFORTS.map(step)),
		)
	})
	// Bots below the runners: click to ask one here, shift-click to ask it too.
	const asking = (b) => picks.some((p) => p.name === b.name)
	const botRows =
		recipeFor || !bots.length
			? []
			: [
					el('li', {}, el('h4', { textContent: 'Bots' })),
					...bots.map((b) =>
						el(
							'li',
							{ className: asking(b) ? 'on' : '' },
							el(
								'button',
								{
									type: 'button',
									className: `model${asking(b) ? ' on' : ''}`,
									onclick: (e) => {
										choose(
											e.shiftKey
												? asking(b)
													? picks.filter((p) => p.name !== b.name)
													: [...picks, { name: b.name }]
												: [{ name: b.name }],
										)
										if (!e.shiftKey) $picker.hidePopover()
									},
								},
								el('span', { textContent: b.name, style: colorOf(b.name) }),
								el('small', { textContent: name(b.to) }),
							),
						),
					),
				]
	$picker
		.querySelector('ul')
		.replaceChildren(
			...(rows.length
				? rows
				: [el('li', { className: 'mute', textContent: 'No runner is online.' })]),
			...botRows,
		)
}
// The picker sets a bot's recipe instead, when its sheet opens it.
let recipeFor = null
$picker.addEventListener('toggle', (e) => {
	if (e.newState === 'closed') recipeFor = null
})
const saveBot = (change) =>
	api('/api/bots', change)
		.then(refresh)
		.catch((error) => alert(error.message))

// The runners connected to this server: who's there, where, and what they're doing; and how to add one.
$('fleet-open').onclick = () => $('fleet').togglePopover()
$('fleet').addEventListener('toggle', (e) => {
	if (e.newState === 'open') {
		fleetRows()
		place($('fleet'), $('fleet-open'))
	}
})
function fleetRows() {
	const busy = (r) =>
		threads.flatMap((t) =>
			t.agents
				.filter((a) => a.to.runner === r.name && a.status === 'working')
				.map((a) => ({ t, a })),
		)
	$('fleet')
		.querySelector('ul')
		.replaceChildren(
			...runners.map((r) => {
				const work = busy(r)
				const hands = work.map(({ t, a }) => handsOf(live.get(`${t.id} ${a.name}`))).find(Boolean)
				return el(
					'li',
					{},
					el('span', { className: light(r.online ? (work.length ? 'working' : 'on') : '') }),
					el(
						'div',
						{},
						el('b', { textContent: r.name }),
						el('small', { textContent: r.dir }),
						(!r.online || work.length > 0) &&
							el('small', {
								className: r.online ? 'doing' : '',
								textContent: !r.online
									? 'offline'
									: hands || `working in ${work.map(({ t }) => t.title || 'untitled').join(', ')}`,
							}),
					),
				)
			}),
		)
	$('fleet').querySelector('pre').textContent = $('lend').textContent
}

// Fetches what changed; the server says when over /ws.
let fetching = null,
	again = false
async function refresh() {
	if (fetching) return void (again = true)
	fetching = (async () => {
		const [r, t] = await Promise.all([
			api('/api/runners').catch(() => null),
			api('/api/threads').catch(() => null),
		])
		up = Boolean(r)
		runners = r ?? []
		threads = t ?? []
		const { modules = [] } = (await api('/api/server').catch(() => null)) ?? {}
		botsOn = modules.includes('bots')
		bots = botsOn ? await api('/api/bots').catch(() => bots) : []
		// A thread that's gone, deleted here or elsewhere, leaves a new one in its place.
		if (t && current && !threads.some((x) => x.id === current)) current = null
		const home = runners.find((x) => x.online) ?? runners[0]
		if (!picks.length && home?.model) choose([{ runner: home.name, ...setting(home) }])
		// Opened straight at a bot's home, as from a link.
		if (botAt(current) && !beforeHome) {
			beforeHome = picks
			choose([{ name: botAt(current).name }])
		}
		await Promise.all(
			family().map(async (id) => {
				const view = await api(`/api/threads/${id}`).catch(() => null)
				details.set(id, view?.entries ?? details.get(id) ?? [])
				people.set(id, view?.people ?? people.get(id) ?? [])
			}),
		)
		watchAll()
		render()
	})()
	await fetching
	fetching = null
	if (again) {
		again = false
		refresh()
	}
}

// One socket hears that something changed; one per thread on screen streams what its agents are doing.
function pulse() {
	const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`)
	socket.onopen = refresh
	socket.onmessage = refresh
	socket.onclose = () => {
		up = false
		render()
		setTimeout(pulse, 1000)
	}
}
const watchers = new Map()
function watchAll() {
	const shown = new Set(family())
	for (const [id, socket] of watchers)
		if (!shown.has(id)) {
			socket.onclose = null
			socket.close()
			watchers.delete(id)
		}
	for (const id of shown) {
		if (watchers.has(id)) continue
		const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`)
		socket.onopen = () => socket.send(JSON.stringify({ watch: id }))
		socket.onmessage = (m) => {
			const { thread, agent: who, events } = JSON.parse(m.data)
			if (!who || !events) return
			for (const e of events)
				live.set(
					`${thread} ${who}`,
					step(live.get(`${thread} ${who}`) ?? { run: false, message: null, tools: [] }, e),
				)
			render()
		}
		socket.onclose = () => {
			watchers.delete(id)
		}
		watchers.set(id, socket)
	}
}

// Pi's agent events, down to what this page shows: the reply being written and the tool calls of this run.
function step(state, e) {
	const tool = (id, change) => {
		const old = state.tools.find((t) => t.callId === id) ?? { callId: id, name: e.toolName }
		return { ...state, tools: [...state.tools.filter((t) => t !== old), { ...old, ...change }] }
	}
	switch (e.type) {
		case 'snapshot':
			return { run: Boolean(e.run), message: e.generation?.message ?? null, tools: e.tools ?? [] }
		case 'run_start':
			return { ...state, run: true }
		case 'run_end':
			return { run: false, message: null, tools: [] }
		case 'message_start':
			return e.message.role === 'assistant' ? { ...state, message: e.message } : state
		case 'message_update':
			return state.message
				? { ...state, message: e.changes.reduce(changed, structuredClone(state.message)) }
				: state
		case 'message_end':
			return { ...state, message: null }
		case 'tool_execution_start':
			return tool(e.toolCallId, { args: e.args, status: 'running' })
		case 'tool_execution_end':
			return tool(e.toolCallId, { status: 'done' })
		default:
			return state
	}
}
function changed(message, c) {
	const blocks = message.content
	if (c.type === 'message') return structuredClone(c.message)
	if (c.type.endsWith('_start')) blocks.splice(c.contentIndex, 0, structuredClone(c.block))
	else if (c.type === 'block') blocks[c.contentIndex] = structuredClone(c.block)
	else if (c.type === 'text_delta') blocks[c.contentIndex].text += c.delta
	else if (c.type === 'thinking_delta') blocks[c.contentIndex].thinking += c.delta
	return message
}
const text = (message) =>
	(message?.content ?? [])
		.filter((b) => b.type === 'text')
		.map((b) => b.text)
		.join('')
const handsOf = (state) => {
	const t = state?.run && state.tools.at(-1)
	if (!t) return ''
	const a = t.args ?? {}
	return `${t.name} ${a.command ?? a.path ?? a.pattern ?? a.query ?? a.body ?? ''}`.trim()
}

// One box per thread on screen; the composer sits in the current one.
const boxes = new Map()
function threadBox(id) {
	const t = threads.find((x) => x.id === id)
	let box = boxes.get(id)
	if (!box) {
		// A thread that isn't current shows a box to write in all the same; clicking it brings the composer, and its model the picker.
		const write = el(
			'form',
			{ className: 'elsewhere' },
			el(
				'div',
				{ className: 'box' },
				el('input', { placeholder: 'Write here', onfocus: () => go(id) }),
			),
			el(
				'div',
				{ className: 'bar' },
				...[...form.querySelector('.bar').children]
					.filter((c) => c !== $to)
					.map((c) => c.cloneNode(true)),
			),
		)
		write.querySelector('.pick').onclick = () => {
			go(id)
			render()
			$picker.showPopover()
		}
		box = el(
			'article',
			{ className: 'thread' },
			el('header', { onclick: header(id) }, el('span'), el('span', { className: 'dot' })),
			handsControl(t?.tools, (tools) => api(`/api/threads/${id}/tools`, { tools }).then(refresh)),
			el('nav', { className: 'from' }),
			el('ul'),
			write,
		)
		boxes.set(id, box)
	}
	box.classList.toggle('current', id === current)
	box.classList.toggle('hands-off', Boolean(t?.tools))
	box.querySelector('.hands').show(t?.tools)
	const [title, dot] = box.querySelector('header').children
	title.textContent = t?.title || 'untitled'
	dot.className = light(t?.status)
	// A fork says where it came from up top; a thread an agent started says it on the question it was asked.
	const origin = forkOf(t)
	const from = box.querySelector('nav.from')
	const fromSig = JSON.stringify([origin, titleOf(origin)])
	if (from.dataset.sig !== fromSig) {
		from.dataset.sig = fromSig
		from.replaceChildren(...(origin ? [link(origin, `← forked from ${titleOf(origin)}`)] : []))
	}
	box.querySelector('form.elsewhere').hidden = id === current
	box.querySelector('form.elsewhere .pick').replaceChildren(...$pick.cloneNode(true).childNodes)
	// Messages, then any reply still being written; the list keeps its place unless it was at the bottom.
	const list = box.querySelector('ul')
	const writing = (t?.agents ?? [])
		.map((a) => {
			const state = live.get(`${id} ${a.name}`)
			return [a.name, text(state?.message), handsOf(state)]
		})
		.filter(([, s, h]) => s || h)
	const entries = (details.get(id) ?? []).filter((x) => x.kind === 'agent-ide.message')
	// Forks made from a message, as links under it.
	const forksAt = new Map()
	for (const f of threads)
		if (forkOf(f) === id && !f.hidden)
			forksAt.set(f.conversation.parent.at, [...(forksAt.get(f.conversation.parent.at) ?? []), f])
	const sig = JSON.stringify([
		botAt(id)?.instructions === '',
		entries.map((x) => x.id),
		writing,
		[...forksAt].map(([at, fs]) => [at, fs.map((f) => [f.id, f.title, f.status])]),
	])
	if (list.dataset.sig !== sig) {
		list.dataset.sig = sig
		const grew = entries.length + writing.length > list.children.length
		const stuck = grew || list.scrollTop + list.clientHeight >= list.scrollHeight - 4
		const newBot = botAt(id)?.instructions === '' && botAt(id)
		list.replaceChildren(
			// Page chrome, not a message: nobody said it.
			...(newBot
				? [
						el('li', {
							className: 'mute',
							textContent: `${newBot.name} has no soul yet. Talk to ${newBot.name} and find out who it is.`,
						}),
					]
				: []),
			// A message from another thread is a card: an answer to a post comes back as a reply, a post arrives as a question.
			...entries.map(({ id: at, data }, i) =>
				el(
					'li',
					{
						className:
							data.from && data.from !== id
								? `elsewhere${data.re ? ' reply' : ''}`
								: data.author === me
									? 'mine'
									: !entries[i - 1]?.data.from && entries[i - 1]?.data.author === data.author
										? 'same'
										: '',
					},
					data.from &&
						data.from !== id &&
						el(
							'div',
							{ className: 'links' },
							link(
								data.from,
								`${data.re ? '↩ answer from' : '→ asked from'} ${titleOf(data.from)}`,
							),
						),
					el('small', { title: data.author, style: colorOf(data.author) }, who(data.author)),
					el('span', { className: 'body' }, data.body),
					...(forksAt.get(at) ?? []).map((f) =>
						el('div', { className: 'links' }, link(f.id, `forked → ${f.title}`)),
					),
					el('button', {
						className: 'fork',
						textContent: 'fork',
						title: 'A new thread from this message',
						onclick: () => fork(id, at),
					}),
				),
			),
			...writing.map(([name, s, hands]) =>
				el(
					'li',
					{ className: 'writing' },
					el('small', { textContent: `${who(name)} · ${hands || 'writing'}`, title: hands }),
					s,
				),
			),
		)
		if (stuck) list.scrollTop = list.scrollHeight
	}
	if (id === current && form.parentNode !== box) box.append(form)
	return box
}
// A thread as a row, the same in the list of all threads and in a thread's family: its light, its name, delete on hover,
// and retry when crashes left its work parked.
const threadRow = (t, depth = 0) =>
	el(
		'li',
		{
			className: t.id === current ? 'current' : '',
			title: t.title,
			style: `--depth: ${depth}`,
			onclick: () => go(t.id),
		},
		el('span', { className: light(t.status) }),
		el('span', { textContent: t.title || 'untitled' }),
		t.status === 'parked' &&
			el('button', {
				textContent: 'retry',
				title: 'Crashes kept cutting this work off; run it again',
				onclick: (e) => {
					e.stopPropagation()
					api(`/api/threads/${t.id}/retry`, {})
				},
			}),
		el('button', {
			textContent: 'delete',
			title: 'Delete this thread',
			onclick: (e) => {
				e.stopPropagation()
				remove(t.id)
			},
		}),
	)
// A bot as a row: lit while an agent of its name works anywhere, its name in its color; it opens its home.
const botRow = (b) => {
	const mine = threads.flatMap((t) => t.agents.filter((a) => a.name === b.name))
	const state = mine.some((a) => a.status === 'working')
		? 'working'
		: mine.some((a) => ['blocked', 'parked'].includes(a.status))
			? 'blocked'
			: ''
	return el(
		'li',
		{ className: b.home === current ? 'current' : '', title: b.instructions.split('\n')[0], onclick: () => go(b.home) },
		el('span', { className: light(state) }),
		el('span', { textContent: b.name, style: colorOf(b.name) }),
	)
}
// A new bot: its name first, which is how anyone asks it; it starts on the model the composer would ask.
function nameBot() {
	const pick = picks.find((p) => p.runner)
	const field = el('input', {
		placeholder: 'a name',
		spellcheck: false,
		title: 'How anyone asks it, in any thread',
		onkeydown: async (e) => {
			if (e.key === 'Escape') return field.blur()
			if (e.key !== 'Enter') return
			try {
				if (!pick) throw new Error('Pick a model first: a new bot starts on it')
				const { home } = await api('/api/bots', { name: field.value.trim(), to: { ...pick, name: undefined } })
				bots = await api('/api/bots')
				field.blur()
				go(home)
			} catch (error) {
				field.classList.add('bad')
				field.title = error.message
			}
		},
		onblur: () => setTimeout(render),
	})
	$('list').querySelector('ul.bots').prepend(el('li', {}, field))
	field.focus()
}
// An agent goes by its model's own name and where it runs; the full id is on hover.
const who = (author) => author?.replace(/^(?:[^@]*\/)?([^/@:]+)(?::[^@]*)?@(.+)$/, '$1 · $2') ?? ''
const titleOf = (id) => threads.find((t) => t.id === id)?.title || `thread ${id}`
// A bot's color comes from its name, the same in every client.
const hue = (name) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const colorOf = (author) =>
	bots.some((b) => b.name === author) ? `color: oklch(0.6 0.14 ${hue(author)})` : ''
const botAt = (id) => bots.find((b) => b.home === id)
// A link to another thread; its light lives in its own header and the list.
function link(id, label) {
	return el(
		'a',
		{
			href: `?${new URLSearchParams({ ...Object.fromEntries(params), thread: id })}`,
			className: 'thread-link',
			onclick: (e) => {
				e.preventDefault()
				go(id)
			},
		},
		label,
	)
}
async function fork(id, at) {
	go((await api(`/api/threads/${id}/fork`, { at })).id)
}

const w = wires($('canvas'))
let blankBox
function render() {
	if ($('memory').getAttribute('thread') !== String(current ?? ''))
		$('memory').setAttribute('thread', current ?? '')
	$('server').classList.toggle('off', !up)
	$('server').querySelector('.dot').className = light(up ? 'on' : '')
	$('server').querySelector('code').textContent = url
	// Another machine can't reach localhost; it needs the server's name on the network.
	const reachable = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url)
		? url.replace(/\/\/[^:/]+/, '//yourbox')
		: url
	$('lend').textContent = `curl -fsSL ${reachable}/connect-runner | sh -s -- --dir ~/code`

	const shown = family()
	const shownThreads = shown.map((id) => threads.find((t) => t.id === id)).filter(Boolean)
	blankBox ??= el(
		'article',
		{ className: 'thread current' },
		el('header', { onclick: header(null) }, el('span', { textContent: 'a new thread' })),
		handsControl(null, async (tools) => {
			fresh_tools = tools
			blankBox.classList.toggle('hands-off', Boolean(tools))
			blankBox.querySelector('.hands').show(tools)
		}),
	)
	const blank = !current && blankBox
	if (blank && form.parentNode !== blank) blank.append(form)
	// Moved only when they change: taking a box out and back would lose the cursor in it.
	const next = [...shown.map(threadBox), ...(blank ? [blank] : [])]
	if (
		next.length !== $('threads').children.length ||
		next.some((b, i) => $('threads').children[i] !== b)
	)
		$('threads').replaceChildren(...next)
	if (focus && (!current || details.has(current))) {
		focus = false
		form.querySelector('input').focus()
	}
	// Every thread on the server, newest first; a new one always on top. With bots, theirs first: a bot's row is its
	// home thread under its name.
	const homes = new Set(bots.map((b) => b.home))
	if (!$('list').contains(document.activeElement) || document.activeElement.tagName !== 'INPUT')
		$('list').replaceChildren(
			el('button', {
				className: `new${current ? '' : ' current'}`,
				textContent: '+ New thread',
				onclick: () => go(null),
			}),
			...(botsOn
				? [
						el(
							'h3',
							{},
							'Bots',
							el('button', { type: 'button', textContent: '+ new', onclick: nameBot }),
						),
						el('ul', { className: 'bots' }, ...bots.map(botRow)),
						el('h3', { textContent: 'Threads' }),
					]
				: []),
			el(
				'ul',
				{},
				...threads
					.filter((t) => !t.hidden && !homes.has(t.id) && !threads.some((p) => p.id === t.parent))
					.map((t) => threadRow(t)),
			),
			$('fleet-open'),
		)

	// The phone's bar names the thread; its drawer lists the family, children indented under their parent.
	const here = threads.find((t) => t.id === current)
	$('pill').lastChild.textContent = current ? here?.title || 'untitled' : 'New thread'
	$('pill').firstChild.className = light(here?.status)
	$('pill').classList.toggle('hands-off', Boolean(current ? here?.tools : fresh_tools))
	if (!sideHands.contains(document.activeElement))
		sideHands.show(current ? here?.tools : fresh_tools)
	const depth = (id) => {
		let d = 0
		for (let t = threads.find((x) => x.id === id); d < 20; d++) {
			const p = t?.parent ?? forkOf(t)
			if (!shown.includes(p)) break
			t = threads.find((x) => x.id === p)
		}
		return d
	}
	$('family').replaceChildren(...shownThreads.map((t) => threadRow(t, depth(t.id))))
	sheetFor(botAt(current))
	$('members').textContent = [
		...(people.get(current) ?? []),
		...(here?.agents ?? []).map((a) => a.name),
	].join(', ')
	// The composer names whom it asks; the sidebar counts the runners.
	const mineNow = threads.find((t) => t.id === current)?.agents ?? []
	const busyNow = picks.some((p) => mineNow.some((a) => same(a.to, p) && a.status === 'working'))
	$pick.children[1].textContent = picks.length ? picks.map(short).join(' + ') : 'Pick a model'
	$pick.firstChild.className = picks.length ? light(busyNow ? 'working' : 'on') : light()
	$pick.title = $to.value
	const online = runners.filter((r) => r.online).length
	$('fleet-open').replaceChildren(
		...runners.map((r) => el('span', { className: light(r.online ? 'on' : '') })),
		el('span', { textContent: `${online} runner${online === 1 ? '' : 's'} online` }),
	)
	if ($picker.matches(':popover-open') && !$picker.contains(document.activeElement)) pickerRows()
	if ($('fleet').matches(':popover-open')) fleetRows()

	// A runner is one card: click it to ask it, shift-click to ask it too. Its model and thinking are set on the card.
	const asked = shownThreads.flatMap((t) => t.agents.map((a) => ({ ...a, thread: t.id })))
	const sig = JSON.stringify([
		runners.map((r) => [r.name, r.online, r.dir, r.model, r.offers]),
		picks,
		chosen,
		asked.map((a) => [a.thread, a.name, a.status]),
		asked.map((a) => handsOf(live.get(`${a.thread} ${a.name}`))),
	])
	if ($('runners').dataset.sig !== sig) {
		$('runners').dataset.sig = sig
		$('runners').replaceChildren(...runners.map((r) => runnerCard(r, asked)))
	}

	// Only the connections live here; wires owns their geometry.
	const down = { fromSide: 'bottom', toSide: 'top', fromAt: 'to' }
	const row = (to) => $('runners').querySelector(`[data-agent="${CSS.escape(slot(to))}"]`)
	const state = (s) => (!s || s === 'idle' ? '' : s)
	const connections = [
		{
			from: $('client'),
			to: $('server'),
			fromSide: 'right',
			toSide: 'left',
			fromAt: 18,
			toAt: 18,
			className: up ? '' : 'off',
		},
	]
	// A runner a thread wires to needs no wire of its own from the server: the thread's is that connection.
	const reached = new Set([
		...picks.map((p) => p.runner),
		...shownThreads.flatMap((t) => t.agents.map((a) => a.to.runner)),
	])
	for (const r of runners)
		if (!reached.has(r.name))
			connections.push({
				...down,
				from: $('server'),
				to: $(`runner-${r.name}`),
				toAt: 40,
				className: up && r.online ? '' : 'off',
			})
	for (const t of shownThreads) {
		const from = boxes.get(t.id)
		for (const a of t.agents) {
			if (t.id === current && picks.some((p) => same(p, a.to))) continue
			connections.push({
				...down,
				from,
				to: row(a.to),
				toAt: -20,
				className: state(a.status),
			})
		}
	}
	const mine = shownThreads.find((t) => t.id === current)?.agents ?? []
	for (const p of picks.filter((p) => p.runner))
		connections.push({
			...down,
			from: $pick,
			to: row(p),
			toAt: -20,
			className: state(mine.find((a) => same(a.to, p))?.status) || 'route',
		})
	w.draw(connections)
}

// What each runner's card is set to: the model and thinking it asks with, kept when it's not picked.
const chosen = {}
const setting = (r) => {
	const p = picks.find((x) => x.runner === r.name)
	// Low thinking unless you turn it up: quick answers suit a page you play with.
	return p
		? { model: p.model, thinkingLevel: p.thinkingLevel }
		: (chosen[r.name] ?? { model: r.model, thinkingLevel: 'low' })
}
function tune(r, change) {
	const next = Object.fromEntries(Object.entries({ ...setting(r), ...change }).filter(([, v]) => v))
	chosen[r.name] = next
	if (picks.some((p) => p.runner === r.name))
		choose(picks.map((p) => (p.runner === r.name ? { runner: r.name, ...next } : p)))
	else render()
}
function toggle(r, also) {
	const self = { runner: r.name, ...setting(r) }
	const on = picks.some((p) => p.runner === r.name)
	if (!also) return choose([self])
	if (!on) return choose([...picks, self])
	if (picks.length > 1) choose(picks.filter((p) => p.runner !== r.name))
}

// One runner: its light, its folder, the model it asks with and how hard it thinks, and what its hands are doing.
// Agents the threads asked here with another model or name get a quiet row of their own, for their wire and light.
function runnerCard(r, asked) {
	const set = setting(r)
	const on = picks.some((p) => p.runner === r.name)
	const here = asked.filter((a) => a.to.runner === r.name)
	// The busiest agent here decides the dot: working beats blocked, and an idle agent is grey.
	const stateOf = (list) =>
		list.some((a) => a.status === 'working')
			? 'working'
			: list.some((a) => ['blocked', 'parked'].includes(a.status))
				? 'blocked'
				: ''
	const row = (to, ...children) => {
		const list = here.filter((a) => slot(a.to) === slot(to)),
			state = stateOf(list)
		const hands = list.map((a) => handsOf(live.get(`${a.thread} ${a.name}`))).find(Boolean)
		const li = el(
			'li',
			{},
			...children,
			list.length && el('span', { className: light(state), title: state || 'idle' }),
			hands && el('span', { className: 'hands', textContent: hands, title: hands }),
		)
		li.dataset.agent = slot(to)
		return li
	}
	const stop = (e) => e.stopPropagation()
	const models = [...new Set([set.model, r.model, ...(r.offers ?? [])].filter(Boolean))]
	const swap = el(
		'select',
		{
			className: 'swap',
			title: 'model',
			onclick: stop,
			onchange: () => tune(r, { model: swap.value }),
		},
		...models.map((o) => new Option(o, o)),
	)
	swap.value = set.model ?? ''
	// How hard it thinks: a slider from the runner's default up to max.
	const knob = el('input', {
		type: 'range',
		min: 0,
		max: EFFORTS.length,
		value: EFFORTS.indexOf(set.thinkingLevel) + 1,
		title: set.thinkingLevel || 'default thinking',
		onclick: stop,
	})
	knob.onchange = () =>
		tune(r, { thinkingLevel: knob.value > 0 ? EFFORTS[knob.value - 1] : undefined })
	const own = { runner: r.name, model: set.model }
	const others = [...new Map(here.map((a) => [slot(a.to), a.to])).values()].filter(
		(to) => slot(to) !== slot(own),
	)
	return el(
		'div',
		{
			className: `node card${r.online ? '' : ' off'}${on ? ' routed' : ''}`,
			id: `runner-${r.name}`,
			title: on ? 'Shift-click to stop asking it' : 'Click to ask it; shift-click to ask it too',
			onclick: (e) => toggle(r, e.shiftKey || e.metaKey || e.ctrlKey),
		},
		el('b', {}, el('span', { className: light(r.online ? stateOf(here) || 'on' : '') }), r.name),
		el('small', { textContent: r.dir }),
		!models.length && el('small', { textContent: 'No models here yet: run pi there and /login.' }),
		el(
			'ul',
			{ className: 'models' },
			models.length && row(own, swap, knob),
			...others.map((to) =>
				row(to, el('span', { className: 'name', textContent: to.name ?? to.model, title: to.model })),
			),
		),
	)
}

// The buttons in the text set the stage up and press go.
const defaults = () =>
	runners
		.filter((r) => r.online && setting(r).model)
		.map((r) => ({ runner: r.name, ...setting(r) }))
const fresh = () => {
	if (current) go(null)
}
const SHED = [
	[
		'Oskar',
		'Shall we finally build the shed this spring? The old one is rotting behind the plum tree.',
	],
	['Ana', 'Yes. I measured the spot: 2.4 by 1.8 metres, flat except the corner by the fence.'],
	['Oskar', 'The allotment gate code is 4417, by the way, for when the timber gets delivered.'],
	['Ben', "I can borrow my uncle's mitre saw from April."],
	['Ana', "Budget? I'd say 6,000 kroner at most."],
	[
		'Oskar',
		"Agreed, 6,000. I went through Stark's price list last night, so here's roughly where it goes.\n\nTimber is the big one: about 3,200 for the frame, the cladding and the floor. The frame is 45×95 studs, the cladding 19 mm boards, the floor 22 mm plywood on joists. Then roofing, which depends on what we pick: felt is around 600, metal closer to 1,400. Screws, nails, hinges and brackets come to about 500 if we buy the big boxes. Paint is another 700 or so for two coats.\n\nThat leaves maybe 600 for whatever we forget, and we always forget something. The concrete blocks for the foundation we already have from the old greenhouse, so those are free.",
	],
	['Ben', 'Roof: felt or corrugated metal? Metal is loud in the rain but lasts forever.'],
	['Ana', 'Felt. The neighbours complained about the last metal roof.'],
	['Oskar', 'Felt it is. Walls: I vote green, like the gate.'],
	['Ana', 'Green is fine by me.'],
	['Ben', 'Foundation: concrete blocks, not a slab. Cheaper, and we can move it.'],
	[
		'Ana',
		"Cut list for the frame, so we can get Stark to cut it and save a day:\n\n- Floor joists: 5 at 1.8 m\n- Bottom and top plates: 4 at 2.4 m, 4 at 1.8 m\n- Studs: 14 at 2.0 m for the front, 14 at 1.8 m for the back, which gives the roof its slope\n- Rafters: 6 at 2.1 m, with a 15 cm overhang front and back\n- Noggins: whatever is left over\n\nThe slope comes out at about 6 degrees, which the felt is fine with as long as we lap it 10 cm. The door goes in the front wall, left of centre, so the shelves can go on the left wall. I've drawn it all on squared paper and taped it to the fridge.",
	],
	['Ana', 'Did it Saturday. Took two wheelbarrows of gravel.'],
	['Ben', 'Timber arrives Thursday the 17th, between 8 and 10.'],
	['Oskar', "I'll be there to open the gate."],
	['Ana', "The delivery guy said the code didn't work, so I let him in."],
	['Oskar', 'Ugh, the association changed it. The new gate code is 9021.'],
	[
		'Ben',
		"Frame is up! Took all of Sunday, and here's what happened, for the record.\n\nWe started at 9 and the first hour went on the joists, because the blocks by the fence weren't quite level after all and Ana had to add another shovel of gravel. The front wall went up easily. The back wall was a fight: one of the 1.8 m studs had a split we didn't see, so we cut a replacement from a 2.0 m and it's 3 mm short, packed with a shim. Rafters went on at 3. The overhang at the back is 15 cm as planned, at the front it's more like 18 because we measured from the outside of the plate.\n\nNothing is square to the millimetre, but it's square enough that the door will hang. My thumb is blue from the hammer.",
	],
	['Ana', "Door: we have the old one from my mum's house, 80 cm wide."],
	['Oskar', "The frame opening is 78 cm. We'll need to plane 2 cm off."],
	['Ben', "Planed it. It fits, a little tight when it's damp."],
	['Ana', 'Roof felt bought: two rolls, 640 kroner.'],
	['Oskar', 'Running total: 4,950 kroner.'],
	['Ben', 'Changed my mind on the colour: green clashes with the new fence. Blue?'],
	['Ana', 'Blue, dark, like a fishing hut.'],
	['Oskar', "Fine, dark blue. I'll return the green paint, 380 back."],
	['Ana', 'Paint bought: dark blue, two buckets.'],
	['Ben', 'First coat on. The second needs a dry day.'],
	[
		'Oskar',
		"Second coat done. The final accounts, since we said we'd keep them:\n\nTimber 3,180. Roof felt 640. Screws, nails and hinges 540. Green paint 380, returned, so 0. Dark blue paint 760. A replacement stud 45. Gravel 0, from the pile. Beers for Sunday 175, which Ana says don't count but I'm counting.\n\nTotal 5,720, under the 6,000 budget by 280. That's lunch at the café by the allotment, or another bucket of paint when the first coat starts to fade.",
	],
	['Ana', 'Shelves from the leftover timber, Ben?'],
	['Ben', 'Three shelves up on the left wall. The mitre saw goes back to my uncle on Friday.'],
	['Oskar', 'Shed done. Housewarming for the shed on Saturday, bring beers.'],
]
const TRIES = {
	hands: () => {
		fresh()
		choose(defaults().slice(0, 1))
		return ask("Which file in this folder is biggest? Look, don't guess. One line.")
	},
	friend: async () => {
		if (!current) go((await api('/api/threads', { title: 'A thread for two' })).id)
		const link = new URL(location.href)
		link.searchParams.set('thread', current)
		link.searchParams.set('user', 'Ana')
		open(link, '_blank')
	},
	two: () => {
		fresh()
		choose(defaults())
		return ask('What machine are you on, and in which folder? One line.')
	},
	slow: () => {
		fresh()
		choose(defaults().slice(0, 1))
		return ask(
			'Count from 1 to 20 in your shell, one number a second: run `for i in $(seq 1 20); do echo $i; sleep 1; done`. Then say how far you got, in one line.',
		)
	},
	fork: async () => {
		const first = (details.get(current) ?? []).find((e) => e.data.answer)
		if (!first) throw new Error('Ask something first: a fork starts from a message.')
		return fork(current, first.id)
	},
	// A thread long enough for memory to show: three people building a shed, with facts that change on the way.
	shed: async () => {
		const { id } = await api('/api/threads', { title: 'The shed', requestId: crypto.randomUUID() })
		for (const [i, [author, body]] of SHED.entries()) {
			await fetch(`${url}/api/threads/${id}/entries`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-user': author },
				body: JSON.stringify({ body, to: null, requestId: `shed-${id}-${i}` }),
			})
		}
		go(id)
	},
	recall: () => {
		if (!current) throw new Error('Load the example thread first.')
		choose(defaults().slice(0, 1))
		return ask(
			'What is the gate code now, what colour is the shed, and how long are the rafters? Say which message you found each in.',
		)
	},
	talk: () => {
		fresh()
		const [first, second = first] = defaults()
		choose([first])
		return ask(
			`Use your post tool to start a thread asking ${name(second)} what is in its folder. Wait for its answer, then tell me in one line.`,
		)
	},
}
for (const b of document.querySelectorAll('[data-try]'))
	b.onclick = () => {
		if (matchMedia('(max-width: 1000px)').matches) $('stage').scrollIntoView({ behavior: 'smooth' })
		TRIES[b.dataset.try]().catch((error) => alert(error.message))
	}

// Memory follows the current thread on its own; the page only says which.
$('concepts').href = `${url}/concepts`
$('memory').setAttribute('server', url)

pulse()
setInterval(refresh, 5000)
