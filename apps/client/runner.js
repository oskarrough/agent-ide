/** Runners show their agents and choose whom the composer asks. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createMemo, createSignal, createUniqueId, For, Show } from 'solid-js'
import { api, minted, runners, server, setMinted, threads } from './server.js'
import { rowOf, doing, lastToolCall, modelsOf, THINKING_LEVELS } from './agent.js'
import { choose, configure, recipients, toFor } from './composer.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { report } from './notice.js'
import { Sure } from './sure.js'
import { Dot } from './dot.js'

export function Runner(props) {
	const runner = () => props.runner
	const to = () => toFor(runner())
	const agents = () => props.agents.filter((agent) => agent.to.runner === runner().name)
	const models = () => modelsOf(runner(), to())
	const others = () =>
		[...new Map(agents().map((agent) => [rowOf(agent.to), agent.to])).values()].filter(
			(other) => rowOf(other) !== rowOf(to()),
		)
	const stop = (event) => event.stopPropagation()
	const pick = () => choose(to())
	// The card is the mouse's way to ask it; its name is the keyboard's, and a press bubbles up to the card.
	return html`
		<div
			class=${() => [
				'node',
				'card',
				{
					off: !runner().online,
					routed: recipients().some((to) => to.runner === runner().name),
				},
			]}
			data-runner=${() => runner().name}
			title="Click to ask it"
			onClick=${pick}
		>
			<button type="button" class="ask">
				<${Dot} state=${() => dotOf(runner())} />${() => runner().name}
			</button>
			<small>${() => runner().dir}</small>
			<${Show} when=${() => runner().dir && !models().length}
				><small>No models here yet: run pi there and /login.</small><//
			>
			<${Show} when=${() => !runner().dir}
				><small>Not connected yet. Run the command on ${() => runner().name}.</small><//
			>
			<ul class="models">
				<${Show} when=${() => models().length}>
					<${AgentRow} to=${() => to()} runner=${() => runner()} agents=${() => agents()}>
						<select
							class="swap"
							aria-label="Model"
							title="model"
							value=${() => to().model ?? ''}
							onClick=${stop}
							onChange=${(event) => configure({ ...to(), model: event.currentTarget.value })}
						>
							<${For} each=${() => models()}
								>${(model) => html`<option value=${() => model}>${() => model}</option>`}<//
							>
						</select>
						<input
							type="range"
							min="0"
							max=${() => THINKING_LEVELS.length}
							aria-label="Thinking"
							value=${() => THINKING_LEVELS.indexOf(to().thinkingLevel) + 1}
							title=${() => to().thinkingLevel || 'default thinking'}
							onClick=${stop}
							onInput=${(event) =>
								configure({
									...to(),
									thinkingLevel: THINKING_LEVELS[event.currentTarget.value - 1],
								})}
						/>
					<//>
				<//>
				<${For} each=${() => others()}
					>${(to) => html`
						<${AgentRow} to=${() => to} runner=${() => runner()} agents=${() => agents()}>
							<span class="name" title=${() => to.model}>${() => to.name ?? to.model}</span>
						<//>
					`}<//
				>
			</ul>
		</div>
	`
}

const dotOf = (runner) =>
	runner.status && runner.status !== 'idle' ? runner.status : runner.online ? 'on' : ''

function AgentRow(props) {
	const agents = () => props.agents.filter((agent) => rowOf(agent.to) === rowOf(props.to))
	const status = () => props.runner.agents?.[rowOf(props.to)] ?? 'idle'
	const call = () =>
		agents()
			.map((agent) => lastToolCall(doing[agent.thread]?.[agent.conversation]))
			.find(Boolean)
	return html`
		<li data-agent=${() => rowOf(props.to)}>
			${() => props.children}
			<${Show} when=${() => agents().length}><${Dot} state=${status} title=${status} /><//>
			<${Show} when=${() => call()}
				><span class="hands" title=${() => call()}>${() => call()}</span><//
			>
		</li>
	`
}

export function RunnerList() {
	let button, panel
	const id = createUniqueId()
	const online = () => runners.filter((runner) => runner.online).length
	return html`
		<button
			class="ghost small foot-toggle runner-toggle"
			type="button"
			title=${() => `${online()} runner${online() === 1 ? '' : 's'} online`}
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<${For} each=${() => runners}
				>${(runner) => html`<${Dot} state=${() => (runner.status === 'blocked' ? 'blocked' : runner.online ? 'on' : '')} />`}<//
			>
			<span>${() => `${online()} online`}</span>
		</button>
		<div
			class="popover runner-list"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open') placePopover(panel, button)
			}}
		>
			<${Panes}
				title="Runners"
				open=${() => false}
				close=${html`<button type="button" class="ghost small close" aria-label="Close" onClick=${() => panel.hidePopover()}><${Icon} name="close" /></button>`}
			>
				<ul class="rows">
					<${For} each=${() => runners}
						>${(runner) => html`<${RunnerItem} runner=${() => runner} />`}<//
					>
				</ul>
				<${ConnectRunner} />
			<//>
		</div>
	`
}

function RunnerItem(props) {
	const asking = (status) =>
		threads.flatMap((thread) =>
			thread.agents
				.filter((agent) => agent.to?.runner === props.runner.name && agent.status === status)
				.map((agent) => ({
					thread: thread.id,
					title: thread.title,
					conversation: agent.conversation,
				})),
		)
	const work = createMemo(() => asking('working'))
	/** Threads asking it while it's away */
	const waiting = createMemo(() => [...new Set(asking('blocked').map((work) => work.title))])
	const call = () =>
		work()
			.map((agent) => lastToolCall(doing[agent.thread]?.[agent.conversation]))
			.find(Boolean)
	const revoke = async (_e) => {
		const { name } = props.runner
		try {
			await api(`/api/runners/${encodeURIComponent(name)}`, undefined, 'DELETE')
			if (minted()?.name === name) setMinted(null)
		} catch (failure) {
			report(failure)
		}
	}
	return html`
		<li>
			<${Dot} state=${() => dotOf(props.runner)} />
			<div>
				<b>${() => props.runner.name}</b>
				<small>${() => props.runner.dir ?? 'waiting for it to dial in'}</small>
				<${Show} when=${() => props.runner.dir && (!props.runner.online || work().length)}>
					<small class=${() => ({ doing: props.runner.online })}
						>${() =>
							!props.runner.online
								? `offline${waiting().length ? `, ${waiting().join(', ')} waiting for it` : ''}`
								: call() ||
									`working in ${work()
										.map((work) => work.title)
										.join(', ')}`}</small
					>
				<//>
			</div>
			<${Show} when=${() => server().local}>
				<${Sure}
					class="small revoke"
					title="Take its key away"
					ask="revoke?"
					why=${() =>
						"It goes offline and can't dial back; threads that asked it wait for the name." +
						(props.runner.own
							? " It's the server's own runner, so it's back when the server restarts, unless RUNNER=0."
							: '')}
					onConfirm=${revoke}
					>revoke<//
				>
			<//>
		</li>
	`
}

/** A name makes a key and the command that connects it; a name already in the list gets a new one. */
export function ConnectRunner(props) {
	const [name, setName] = createSignal(props.name ?? '')
	const [error, setError] = createSignal('')
	const [busy, setBusy] = createSignal(false)
	const [copied, setCopied] = createSignal(false)
	// A new key for an online runner cuts it off, so the button asks first, in its own words.
	const [cutting, setCutting] = createSignal(false)
	const existing = () => runners.find((runner) => runner.name === name().trim())
	const submit = async (event) => {
		event.preventDefault()
		if (existing()?.online && !cutting()) return setCutting(true)
		setCutting(false)
		setBusy(true)
		setError('')
		try {
			setMinted(await api('/api/runners', { name: name().trim() }))
			setName('')
			setCopied(false)
		} catch (failure) {
			setError(failure.message)
		} finally {
			setBusy(false)
		}
	}
	const copy = () =>
		navigator.clipboard
			.writeText(minted().connect)
			.then(() => setCopied(true))
			.catch(report)
	return html`
		<div class="connect-runner">
			<${Show}
				when=${() => server().local}
				fallback=${html`
					<p class="mute">Add and revoke runners from the server's own machine.</p>
				`}
			>
				<form onSubmit=${submit}>
					<input
						aria-label="Runner name"
						placeholder="a name, like laptop"
						spellcheck="false"
						autocomplete="off"
						required
						value=${() => name()}
						onInput=${(event) => {
							setName(event.currentTarget.value)
							setCutting(false)
						}}
					/>
					<button type="submit" disabled=${() => busy()} onBlur=${(_e) => setCutting(false)}>
						${() => (cutting() ? 'Cut it off?' : existing() ? 'New key' : 'Add runner')}
					</button>
				</form>
				<${Show} when=${cutting}>
					<p class="mute">
						${() =>
							`${name().trim()} is online. A new key cuts it off until you run the new command there.`}
					</p>
				<//>
				<${Show} when=${() => error()}><p class="bad">${() => error()}</p><//>
				<${Show} when=${minted}>
					<div class="command">
						<pre>${() => minted().connect}</pre>
						<button type="button" class="small" onClick=${copy}>
							${() => (copied() ? 'Copied' : 'Copy')}
						</button>
					</div>
					<p class="mute">
						${() =>
							`Run it on ${minted().name}, in the folder agents should work in. ` +
							'It holds the key, so keep it private.'}
					</p>
				<//>
			<//>
		</div>
	`
}
