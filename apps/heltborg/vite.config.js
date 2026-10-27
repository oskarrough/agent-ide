import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'

// /api goes to a running agent-ide server (PORT, default 3000).
export default defineConfig({
	plugins: [solid()],
	server: { proxy: { '/api': `http://localhost:${process.env.PORT || 3000}` } },
})
