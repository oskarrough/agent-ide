// An unread answer stays done however many messages that ask nobody pile up on top of it.
import { answered, api, check, done, say, scriptedRunner, server, view } from './lib.js';

let srv = await server();
const bot = await scriptedRunner('bot', () => say('finished'));
const { json: { id } } = await api('POST', '/api/threads', { title: 'unread' });
await api('POST', `/api/threads/${id}/entries`, { body: 'answer me', to: { runner: 'bot', model: 'echo/echo' } });
check((await answered(id))?.status === 'done', 'an unread answer makes the thread done');
for (let i = 0; i < 60; i++) await api('POST', `/api/threads/${id}/entries`, { body: `note ${i}`, to: null });
check((await view(id)).status === 'done', 'and still does under 60 notes', (await view(id)).status);
const exited = new Promise((resolve) => srv.once('exit', resolve));
srv.kill('SIGKILL');
await exited;
srv = await server();
check((await view(id)).status === 'done', 'including after a restart');
await api('POST', `/api/threads/${id}/read`, {});
check((await view(id)).status === 'idle', 'until it is read');
bot.close();
done();
