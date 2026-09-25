# Realtime threads

A small SQLite server and browser client. No dependencies or build step; requires Node.js 24+.

```sh
npm start
```

Open `http://127.0.0.1:3000` in two tabs. Create a thread, select it in both tabs, and post an event. Both tabs update without a reload.

To connect from another device, run `HOST=0.0.0.0 npm start` and open `http://<server-ip>:3000`. The browser's server URL field can point to any reachable instance. The server has no authentication; use it on a trusted network.

API: `GET` and `POST /api/threads` (`{"title":"Demo"}`), `GET` and `POST /api/threads/:id/events` (`{"body":"Hello"}`). Connect to `/ws` for change notifications; read the records through HTTP. Data is stored in `threads.db` by default.
