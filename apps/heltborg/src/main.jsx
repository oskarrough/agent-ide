import { createMemo, createSignal, Errored, Loading } from 'solid-js'
import { render } from '@solidjs/web'

function App() {
	const [count, setCount] = createSignal(0)
	const server = createMemo(() => fetch('/api/server').then((r) => r.json()))
	return (
		<main>
			<h1>Hello, heltborg</h1>
			<button onClick={() => setCount((n) => n + 1)}>clicked {count()}</button>
			<Errored fallback={(error) => <p>No agent-ide server: {String(error())}</p>}>
				<Loading fallback={<p>Asking /api/server…</p>}>
					<p>
						agent-ide on port {server().port}: {server().threads} threads, modules{' '}
						{server().modules.join(', ')}
					</p>
				</Loading>
			</Errored>
		</main>
	)
}

render(() => <App />, document.getElementById('app'))
