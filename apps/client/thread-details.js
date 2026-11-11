/** Details and tools for the thread on screen, or the one about to start. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createEffect, createSignal, For, Show } from 'solid-js'
import {
	api,
	colorOf,
	current,
	drawer,
	family,
	forkedFrom,
	homeBot,
	newThreadTools,
	people,
	reloadThreads,
	server,
	setNewThreadTools,
	threads,
} from './server.js'
import { shortLabel } from './agent.js'
import { BotSettings, botThreads } from './bot.js'
import { ThreadItem } from './thread-list.js'
import { Dot, Switch } from './dot.js'
import { PiSource } from './pi-sessions.js'

export function ThreadDetails() {
	const here = () => threads.find((thread) => thread.id === current())
	// A bot's home is named for it already, so only who else is there; each once, as an ask's line names them
	const members = () => [
		...new Map(
			[...(people[current()] ?? []), ...(here()?.agents ?? []).map((agent) => agent.name)]
				.filter((name) => name !== homeBot(current())?.name)
				.map((name) => [shortLabel(name), name]),
		).values(),
	]
	const depth = (id) => here()?.family.find((member) => member.id === id)?.depth ?? 0
	const parentOf = (id) => {
		const thread = threads.find((member) => member.id === id)
		return thread?.parent ?? forkedFrom(thread)
	}
	/**
	 * The sheet's own line of descent: ancestors up to the root, itself, and its own descendants.
	 * No siblings or cousins. A root thread's line is still every one of its children.
	 */
	const lineage = () => {
		const ids = family()
		const id = current()
		if (!ids.includes(id)) return ids
		const ancestors = new Set()
		for (let above = parentOf(id); ids.includes(above); above = parentOf(above))
			ancestors.add(above)
		const descendants = new Set()
		const open = [id]
		while (open.length) {
			const parent = open.pop()
			for (const child of ids)
				if (!descendants.has(child) && parentOf(child) === parent) {
					descendants.add(child)
					open.push(child)
				}
		}
		return ids.filter((member) => member === id || ancestors.has(member) || descendants.has(member))
	}
	// A bot's threads are a page of their own: a bot with hundreds of them must not push its own settings off the sheet
	const [page, setPage] = createSignal(false)
	createEffect(current, () => {
		setPage(false)
	})
	let sheet
	createEffect(page, (open) => {
		if (open) sheet.scrollTop = 0
	})
	const botFamily = () => {
		const bot = homeBot(current())
		return bot ? botThreads(bot) : { own: [], elsewhere: [] }
	}
	// The same tools for whichever thread is on screen, mounted anew when it changes
	const tools = () =>
		html`<h2>Tools</h2>
			<${For} each=${() => [current()]}>${(id) => html`<${Tools} thread=${id} />`}<//>`
	return html`
		<div class="scrim" onClick=${() => drawer(null)}></div>
		<section
			class="thread-details"
			aria-label="Thread details"
			ref=${(element) => (sheet = element)}
		>
			<button
				type="button"
				class="ghost small close"
				aria-label="Close"
				onClick=${() => drawer(null)}
			>
				<${Icon} name="close" />
			</button>
			<${Show} when=${() => !page()}>
				<${Show} when=${current} keyed>${(id) => html`<${Title} thread=${id} />`}<//>
				<${Show} when=${() => members().length > 1}>
					<h2>In this thread</h2>
					<p id="members">
						<${For} each=${() => members()}>
							${(name, index) => [
								() => (index() ? ', ' : ''),
								html`<span title=${() => name} style=${() => colorOf(name)}
									>${() => shortLabel(name)}</span
								>`,
							]}
						<//>
					</p>
				<//>
				<${Show} when=${() => server().modules.includes('pi-sessions') && current()} keyed
					>${(id) => html`<${PiSource} thread=${id} />`}<//
				>
				<${Show} when=${() => homeBot(current())} keyed
					>${(bot) =>
						html`<${BotSettings}
							bot=${() => bot}
							onThreads=${(_event) => setPage(true)}
							tools=${tools()}
						/>`}<//
				>
				<${Show} when=${() => !homeBot(current())}>
					<${Show} when=${() => lineage().length > 1}>
						<ul class="thread-family">
							<${For}
								each=${() =>
									lineage()
										.map((id) => threads.find((thread) => thread.id === id))
										.filter(Boolean)}
							>
								${(thread) =>
									html`<${ThreadItem} thread=${() => thread} depth=${() => depth(thread.id)} />`}
							<//>
						</ul>
					<//>
					${tools()}
				<//>
			<//>
			<${Show} when=${page}>
				<header class="page-head">
					<button
						type="button"
						class="ghost small"
						aria-label="Back to the bot"
						onClick=${() => setPage(false)}
					>
						<${Icon} name="back" />
					</button>
					<h2>Threads</h2>
				</header>
				<ul class="thread-family">
					<${For} each=${() => botFamily().own}
						>${(thread) =>
							html`<${ThreadItem} thread=${() => thread} depth=${() => depth(thread.id) - 1} />`}<//
					>
				</ul>
				<${Show} when=${() => botFamily().elsewhere.length}>
					<h2>Also in</h2>
					<ul class="thread-family">
						<${For} each=${() => botFamily().elsewhere}
							>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//
						>
					</ul>
				<//>
			<//>
		</section>
	`
}

function Title(props) {
	const title = () => threads.find((thread) => thread.id === props.thread)?.title ?? ''
	const [error, setError] = createSignal('')
	const save = async (field) => {
		const next = field.value.trim()
		if (next === title()) return
		setError('')
		try {
			await api(`/api/threads/${props.thread}/title`, { title: next })
			reloadThreads()
		} catch (failure) {
			setError(failure.message)
			field.value = title()
		}
	}
	// The model writes a new one, and the request answers once it's written or why it wasn't; till then the button blinks
	const [asking, setAsking] = createSignal(false)
	const [failed, setFailed] = createSignal('')
	const regenerate = async () => {
		setError('')
		setFailed('')
		setAsking(true)
		try {
			await api(`/api/threads/${props.thread}/auto-title`, {})
			reloadThreads()
		} catch (failure) {
			setFailed(`No new title: ${failure.message}`)
		} finally {
			setAsking(false)
		}
	}
	return html`<h2 class="thread-title">
			<input
				class=${() => ['bare', { bad: !!error() }]}
				aria-label="Thread title"
				title=${() => error() || 'Rename this thread'}
				value=${title}
				onChange=${(event) => save(event.currentTarget)}
				onKeyDown=${(event) => {
					if (event.key === 'Enter') event.currentTarget.blur()
					if (event.key === 'Escape') {
						event.currentTarget.value = title()
						event.currentTarget.blur()
					}
				}}
			/>
			<${Show} when=${() => server().modules.includes('auto-title') && !homeBot(props.thread)}>
				<button
					type="button"
					class="ghost small"
					aria-label=${() => (asking() ? 'Writing a new title' : 'New title')}
					title=${() => (asking() ? 'Writing a new title…' : 'Ask the model for a new title')}
					disabled=${asking}
					onClick=${(_event) => regenerate()}
				>
					<${Show} when=${asking} fallback=${html`<${Icon} name="again" />`}>
						<${Dot} state="working" />
					<//>
				</button>
			<//>
		</h2>
		<${Show} when=${failed}>
			<small class="title-failed" role="alert">${failed}</small>
		<//>`
}

function Tools(props) {
	const tools = () =>
		props.thread ? threads.find((thread) => thread.id === props.thread)?.tools : newThreadTools()
	let field
	const [text, setText] = createSignal('')
	createEffect(
		() => (tools() ?? []).join(','),
		(value) => {
			if (document.activeElement !== field) setText(value)
		},
	)
	const [error, setError] = createSignal('')
	const save = async (path, body) => {
		setError('')
		try {
			await api(`/api/threads/${props.thread}/${path}`, body)
			reloadThreads()
		} catch (failure) {
			setError(failure.message)
		}
	}
	const apply = (list) => {
		const tools = list?.length ? list : null
		if (props.thread) return save('tools', { tools })
		setError('')
		setNewThreadTools(tools)
	}
	const here = () => props.thread && threads.find((thread) => thread.id === props.thread)
	return html`
		<div class="hands">
			<${Switch}
				on=${() => !!tools()}
				title="Its agents can look things up, but every change has to go through a thread"
				onToggle=${(on) => apply(on ? HANDS_OFF : null)}
				><span>Hands off</span><//
			>
			<input
				placeholder="every tool"
				aria-label="Thread tools"
				ref=${(el) => {
					field = el
				}}
				spellcheck="false"
				class=${() => ['tools', { bad: !!error() }]}
				title=${() => error() || 'tools, as pi --tools takes them: read,post or -write,-edit,-bash'}
				value=${() => text()}
				onInput=${(event) => setText(event.currentTarget.value)}
				onChange=${() =>
					apply(
						text()
							.split(/[\s,]+/)
							.filter(Boolean),
					)}
				onKeyDown=${(event) => {
					if (event.key === 'Enter') event.currentTarget.blur()
				}}
			/>
		</div>
		<${Show} when=${() => typeof here()?.memory === 'boolean'}>
			<div class="hands">
				<${Switch}
					on=${() => here().memory}
					title="Memory writes a line for each message, so its agents remember the whole thread"
					onToggle=${(on) => save('memory', { on })}
					><span>Memory</span><//
				>
			</div>
		<//>
	`
}

const HANDS_OFF = ['-write', '-edit', '-bash']
