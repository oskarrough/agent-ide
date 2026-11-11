/** Starts a thread from a pi session in one of a runner's folders; and, in a thread's details, says which one it came from. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createSignal, createUniqueId, For, Show } from 'solid-js'
import { api, me, openThread, reloadThreads, runners } from './server.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { report } from './notice.js'

export function PiSessions() {
	let button, panel
	const id = createUniqueId()
	const [where, setWhere] = createSignal('')
	const [found, setFound] = createSignal([])
	const [error, setError] = createSignal('')
	const [starting, setStarting] = createSignal('')
	/** Each folder an online runner offers, as `runner` and `dir` */
	const places = () =>
		runners
			.filter((runner) => runner.online)
			.flatMap((runner) =>
				(runner.folders?.length ? runner.folders : [runner.dir]).map((dir) => ({
					runner: runner.name,
					dir,
				})),
			)
	const place = () =>
		places().find((candidate) => JSON.stringify(candidate) === where()) ?? places()[0]
	const load = async () => {
		setError('')
		setFound([])
		if (!place()) return
		try {
			setFound(await api(`/api/pi-sessions?${new URLSearchParams(place())}`))
		} catch (failure) {
			setError(failure.message)
		}
		// It is as tall as its list now, which may not fit where it first opened
		if (panel.matches(':popover-open')) setTimeout(() => placePopover(panel, button))
	}
	const start = async (session) => {
		setStarting(session.path)
		try {
			const { id: thread } = await api('/api/pi-sessions', {
				...place(),
				session: session.path,
				author: me,
			})
			reloadThreads()
			openThread(thread)
			panel.hidePopover()
		} catch (failure) {
			report(failure)
		} finally {
			setStarting('')
		}
	}
	return html`
		<li class="new">
			<button type="button" class="row" ref=${(el) => (button = el)} popovertarget=${id}>
				<span class="plus" aria-hidden="true"><${Icon} name="plus" /></span>
				<span>From a pi session</span>
			</button>
			<div
				class="popover pi-sessions"
				id=${id}
				popover
				ref=${(el) => (panel = el)}
				onToggle=${(event) => {
					if (event.newState !== 'open') return
					load()
					placePopover(panel, button)
				}}
			>
				<${Panes}
					title="Pi sessions"
					open=${() => false}
					close=${html`<button type="button" class="ghost small close" aria-label="Close" onClick=${() => panel.hidePopover()}><${Icon} name="close" /></button>`}
				>
					<select
						aria-label="Folder"
						value=${() => JSON.stringify(place() ?? '')}
						onChange=${(event) => {
							setWhere(event.currentTarget.value)
							load()
						}}
					>
						<${For} each=${places}
							>${(candidate) =>
								html`<option value=${() => JSON.stringify(candidate)}>
									${() => `${candidate.runner}: ${candidate.dir}`}
								</option>`}<//
						>
					</select>
					<${Show} when=${() => error()}><p class="bad">${() => error()}</p><//>
					<${Show} when=${() => !error() && !found().length}
						><p class="mute">No pi sessions in this folder.</p><//
					>
					<ul class="rows">
						<${For} each=${found}
							>${(session) => html`
								<li>
									<div>
										<b>${() => session.name || session.firstMessage || session.id}</b>
										<small
											>${() =>
												`${session.messageCount} messages, ${new Date(session.modified).toLocaleString()}`}</small
										>
									</div>
									<button
										type="button"
										class="small"
										disabled=${() => starting() === session.path}
										onClick=${() => start(session)}
									>
										Start thread
									</button>
								</li>
							`}<//
						>
					</ul>
				<//>
			</div>
		</li>
	`
}

/** Where an imported thread came from, in its details; nothing for any other thread */
export function PiSource(props) {
	const [from, setFrom] = createSignal(null)
	api(`/api/threads/${props.thread}/pi-sessions`)
		.then((found) => setFrom(found.from))
		.catch(() => {})
	return html`
		<${Show} when=${from}>
			<h2>From pi</h2>
			<p class="mute" title=${() => from().file}>
				${() => `${from().name ?? from().session}, on ${from().runner}`}
			</p>
		<//>
	`
}
