/** The same thread row in the list, its family, and a bot's other threads. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createSignal, For, Show } from 'solid-js'
import {
	archivedThreads,
	archiveThread,
	bots,
	current,
	followThread,
	homeBot,
	hrefOf,
	openThread,
	server,
	threads,
} from './server.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { RunnerList } from './runner.js'
import { Settings } from './settings.js'
import { BotItem, NewBot } from './bot.js'
import { PiSessions } from './pi-sessions.js'

export function ThreadList() {
	const [creating, setCreating] = createSignal(false)
	const [archivedPage, setArchivedPage] = createSignal(false)
	return html`
		<nav class="thread-list" aria-label="Threads">
			<${Show}
				when=${() => !archivedPage()}
				fallback=${html`<${ArchivedPage} onBack=${() => setArchivedPage(false)} />`}
			>
				<${Show} when=${() => server().modules.includes('bots')}>
					<h2>Bots</h2>
					<ul class="bots">
						<${Show}
							when=${() => creating()}
							fallback=${html`<${NewRow} label="New bot" onPick=${(_e) => setCreating(true)} />`}
							><${NewBot} onDone=${(_e) => setCreating(false)}
						/><//>
						<${For} each=${() => bots}>${(bot) => html`<${BotItem} bot=${() => bot} />`}<//>
					</ul>
					<h2>Threads</h2>
				<//>
				<ul>
					<${NewRow}
						label="New thread"
						current=${() => !current()}
						onPick=${(_e) => openThread(null)}
					/>
					<${Show} when=${() => server().modules.includes('pi-sessions')}><${PiSessions} /><//>
					<${For}
						each=${() =>
							threads.filter(
								(thread) =>
									!thread.archived &&
									!homeBot(thread.id) &&
									!threads.some((other) => other.id === thread.parent),
							)}
					>
						${(thread) => html`<${ThreadItem} thread=${() => thread} />`}
					<//>
					<${Show} when=${() => archivedThreads.length}>
						<li class="new">
							<button type="button" class="row" onClick=${() => setArchivedPage(true)}>
								<span class="plus" aria-hidden="true"></span>
								<span>Archived</span>
								<small aria-hidden="true">${() => archivedThreads.length}</small>
							</button>
						</li>
					<//>
				</ul>
			<//>
			<footer class="list-foot">
				<${RunnerList} />
				<${Settings} />
			</footer>
		</nav>
	`
}

function ArchivedPage(props) {
	return html`
		<header class="page-head">
			<button
				type="button"
				class="ghost small"
				aria-label="Back to threads"
				onClick=${() => props.onBack()}
			>
				<${Icon} name="back" />
			</button>
			<h2>Archived</h2>
		</header>
		<ul class="thread-family">
			<${For} each=${() => archivedThreads}>
				${(thread) => html`<${ThreadItem} thread=${() => thread} archived />`}
			<//>
		</ul>
	`
}

function NewRow(props) {
	return html`
		<li class=${() => ['new', { current: props.current }]}>
			<button type="button" class="row" onClick=${() => props.onPick()}>
				<span class="plus" aria-hidden="true"><${Icon} name="plus" /></span>
				<span>${() => props.label}</span>
			</button>
		</li>
	`
}

export function ThreadItem(props) {
	return html`
		<li
			title=${() => props.thread.title}
			style=${() => `--depth: ${props.depth ?? 0}`}
			class=${() => ({ current: props.thread.id === current() })}
		>
			<a
				class="row"
				href=${() => hrefOf(props.thread.id)}
				onClick=${(event) => followThread(event, props.thread.id)}
			>
				<${Dot} state=${() => props.thread.status} />
				<span>${() => props.thread.title}</span>
			</a>
			<${Show} when=${() => !homeBot(props.thread.id)}>
				<button
					type="button"
					class="small archive"
					title=${() => (props.archived ? 'Bring this thread back' : 'Archive this thread')}
					onClick=${() => archiveThread(props.thread.id, !props.archived).catch(report)}
				>
					${() => (props.archived ? 'Unarchive' : 'Archive')}
				</button>
			<//>
		</li>
	`
}
