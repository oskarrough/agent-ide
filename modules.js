// Optional behaviour lives in modules, one file each, on or off by an env var of its name: DIRECTOR=1, TALK=0, STATUS=0.
// A module that's off is never imported. One that's on exports its end, `server(core)` or `runner(core)`, which returns its hooks:
//   server: extension (a Pi extension to install), route(posted, asked), reply(threadId, answeredIn, agent, body, posts, key), changed()
//   runner: told(message), disconnected()
export async function load(end, defaults, core) {
  const on = Object.keys(defaults).filter((name) => {
    const value = process.env[name.toUpperCase()];
    return value ? value !== '0' : defaults[name];
  });
  const modules = [];
  for (const name of on) {
    const make = (await import(`./${name}.js`))[end];
    if (make) modules.push({ name, ...await make(core) });
  }
  return modules;
}
