# matrix-sync

Mention the bot in a Matrix room and an agent files a one-line GitHub issue, answering in a Matrix thread. Ask again in that Matrix thread and it comments on the same issue.

1. Make the bot a Matrix account and invite it to an unencrypted room. [matrix.js](../../matrix.js) says how to get its token.
2. Write `.env` here: `MATRIX_TOKEN`, `MATRIX_ROOMS`, `MATRIX_USERS` (who may mention it), and `REPO`, a checkout where `gh` is logged in. `MODEL` defaults to `openai-codex/gpt-6-luna`, a cheap one.
3. `bun start.js`, or `bun apps/matrix-sync/start.js` from the repo, and watch at http://127.0.0.1:3009.
