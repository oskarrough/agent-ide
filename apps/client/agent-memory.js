// <agent-memory server="http://…" thread="7">: a thread's memory, when its server runs memory.js. One tree: every
// message has a line, two lines merge into one going up. An agent reads one cut through it, as much as its room
// holds, and the slider moves that cut: lines above it are too coarse to need, a line in it opens on click into
// what it was made from, down to a message word for word. It follows the thread on its own.
const el = (tag, props = {}, ...children) => {
	const e = Object.assign(document.createElement(tag), props)
	e.append(...children.filter((c) => c != null && c !== false))
	return e
}
const bytes = (text) => new TextEncoder().encode(text).length
const sizeOf = (lines) => lines.reduce((s, x) => s + bytes(`${x.id}+${x.n}|${x.text}`) + 1, 0)
const unwritten = (x) => x.text.startsWith('(not summarized')

class AgentMemory extends HTMLElement {
	static observedAttributes = ['server', 'thread']

	connectedCallback() {
		this.room = el('input', {
			type: 'range',
			min: 0,
			max: 100,
			value: 30,
			oninput: () => this.draw(),
		})
		this.roomSize = el('span')
		this.bar = el('div', { className: 'bar' })
		this.note = el('p', { className: 'mute' })
		this.tree = el('div')
		this.controls = el(
			'div',
			{},
			el('label', { className: 'room' }, 'Room ', this.room, ' ', this.roomSize),
			this.bar,
			this.note,
		)
		this.replaceChildren(el('div', { className: 'memory reads' }, this.controls, this.tree))
		this.timer = setInterval(() => this.update(), 3000)
		this.update()
	}
	disconnectedCallback() {
		clearInterval(this.timer)
	}
	attributeChangedCallback() {
		if (this.timer) {
			this.seen = ''
			this.update()
		}
	}

	api(path) {
		return fetch(`${this.getAttribute('server')}${path}`).then((r) =>
			r.ok ? r.json() : Promise.reject(new Error(r.status)),
		)
	}
	get thread() {
		return Number(this.getAttribute('thread')) || null
	}

	// Redraws when the thread changes, grows, or has lines still being written.
	async update() {
		if (!this.getAttribute('server')) return
		this.modules ??= (await this.api('/api/server').catch(() => ({}))).modules
		if (!this.modules?.includes('memory'))
			return this.say(
				'This server runs without memory. Start it with ',
				el('code', { textContent: 'MEMORY=1 MEMORY_MODEL=model@runner' }),
				'.',
			)
		const id = this.thread
		if (!id) return this.say()
		const all = (await this.api(`/api/threads/${id}/memory`).catch(() => ({ lines: [] }))).lines
		const T = all.length ? all.at(-1).id + all.at(-1).n : 0
		if (!T) return this.say('No messages yet.')
		const key = `${id} ${T}`
		if (key === this.seen && !this.tree.querySelector('.pending')) return
		// The slider runs from as squeezed as it gets to a line for every message, so all of its length matters.
		const top = (await this.api(`/api/threads/${id}/memory?budget=1`).catch(() => ({ lines: [] })))
			.lines
		this.least = Math.max(100, sizeOf(top))
		this.full = Math.max(this.least * 2, sizeOf(all))
		this.T = T
		this.seen = key
		this.controls.hidden = false
		await this.draw()
	}

	say(...text) {
		this.seen = ''
		this.T = 0
		this.controls.hidden = true
		this.tree.replaceChildren(...(text.length ? [el('p', { className: 'mute' }, ...text)] : []))
	}

	// The tree, opened from the top down to the cut an agent with this much room reads.
	async draw() {
		if (!this.T) return
		const room = Math.round(this.least * (this.full / this.least) ** (this.room.value / 100))
		this.roomSize.textContent =
			room < 1024 ? `${room} B` : `${(room / 1024).toFixed(room < 10240 ? 1 : 0)} KB`
		const turn = (this.turn ?? 0) + 1
		this.turn = turn
		const cut = (
			await this.api(`/api/threads/${this.thread}/memory?budget=${room}`).catch(() => ({
				lines: [],
			}))
		).lines
		const top = 2 ** Math.ceil(Math.log2(Math.max(this.T, 1)))
		const tree =
			cut.length === 1 && cut[0].n >= this.T
				? el('ul', {}, this.line(cut[0], 'cut'))
				: await this.open(0, top, cut)
		if (turn !== this.turn) return
		const T = this.T,
			n = cut.length
		this.bar.replaceChildren(
			...cut.map((x) => {
				// As wide as the messages it stands for, darker the more it squeezes.
				const shade = Math.min(1, Math.log2(x.n) / 5)
				return el('span', {
					title: `${x.id}+${x.n}: ${x.n > 1 ? `${x.n} messages in one line` : 'one message'}`,
					style: `flex-grow:${x.n};background:hsl(215 60% ${88 - shade * 50}%)`,
					onclick: () => this.tree.querySelector(`[data-at="${x.id}+${x.n}"]`)?.click(),
				})
			}),
		)
		this.note.textContent =
			`The agent reads the ${n} highlighted line${n === 1 ? '' : 's'}: ${sizeOf(cut).toLocaleString()} of ${room.toLocaleString()} bytes for ${T} messages. ` +
			(n === T
				? "Room for every message's own line."
				: n <= 2
					? 'As squeezed as it gets: it zooms to read more.'
					: 'Old messages share lines; the latest have one each.')
		this.tree.replaceChildren(tree)
	}

	// The two lines under `id+n`: a line in the cut is highlighted, a line above the cut opens on its own down to it.
	async open(id, n, cut) {
		const inside = (x) => x.id >= id && x.id + x.n <= id + n
		const halves =
			n > 1
				? (await this.api(`/api/threads/${this.thread}/memory?zoom=${id},${n}`).catch(() => ({})))
						.lines
				: null
		if (!halves?.length) return el('ul', {}, ...cut.filter(inside).map((x) => this.line(x, 'cut')))
		// The newest messages wait for a partner to merge with; a line with one half says nothing its half doesn't.
		if (halves.length === 1 && !cut.some((x) => x.id === halves[0].id && x.n === halves[0].n))
			return this.open(halves[0].id, halves[0].n, cut)
		return el(
			'ul',
			{},
			...(await Promise.all(
				halves.map(async (h) => {
					const mine = cut.filter((x) => x.id >= h.id && x.id + x.n <= h.id + h.n)
					if (mine.some((x) => x.id === h.id && x.n === h.n)) return this.line(h, 'cut')
					const li = this.line(h, 'above')
					li.append(await this.open(h.id, h.n, mine))
					return li
				}),
			)),
		)
	}

	// One line. In the cut or below it, a click opens the two lines it was made from, or at n = 1 the message.
	line({ id, n, text }, kind) {
		const waiting = unwritten({ text })
		const label = !waiting
			? text
			: id + n > this.T
				? `the last ${this.T - id} messages, waiting for more before they merge`
				: 'being written, from the messages up'
		const li = el(
			'li',
			{
				className: `${kind}${waiting ? ' pending' : ''}`,
				title: n > 1 ? `messages ${id} to ${id + n - 1}` : `message ${id}`,
			},
			el('small', { textContent: `${id}+${n}` }),
			el('span', { textContent: label }),
		)
		li.dataset.at = `${id}+${n}`
		if (kind === 'above') return li
		li.onclick = async (e) => {
			e.stopPropagation()
			const shown = li.querySelector(':scope > ul, :scope > .whole')
			if (shown) return shown.remove()
			li.classList.add('opening')
			const opened = await this.api(`/api/threads/${this.thread}/memory?zoom=${id},${n}`).finally(
				() => li.classList.remove('opening'),
			)
			li.append(
				opened.message !== undefined
					? el('div', { className: 'whole', textContent: opened.message })
					: el('ul', {}, ...opened.lines.map((x) => this.line(x, 'below'))),
			)
		}
		return li
	}
}
customElements.define('agent-memory', AgentMemory)
