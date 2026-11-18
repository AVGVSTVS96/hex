# Contributing

[AGENTS.md](AGENTS.md) says how hex is put together, and [README.md](README.md) what it's for. For anything bigger than a fix, open an issue first, so we agree on the shape before you build it.

Work on a branch and open a pull request to `main`. Say what it does and the decisions it makes, so a maintainer can review it in a minute. Title it as a [conventional commit](https://www.conventionalcommits.org), `type(scope): what changes, in plain words`, like `fix(update): ship hex only once no hex session is busy`: the maintainer squash-merges it under that title.

## Check

```sh
bun run check   # bun run fix formats
```

`check` checks the formatting ([oxfmt](https://oxc.rs/docs/guide/usage/formatter)), then runs `bin/check`, which builds every channel plugin and the hub and runs the tests, with [Bun](https://bun.sh) and `jq` installed. CI runs it on every pull request, and every hex runs `bin/check` again on `main` before `bin/update` takes a change. `bin/check channels/telegram` checks one package alone. Run a test from the repo's root, as `bun test hub/mcp.test.ts`: there `bunfig.toml` gives each test file a sandbox (`tools/sandbox.ts`), so it finds nothing of a hex that runs on the machine. Several files at once run as `bun test --isolate <files>`, which gives each its own. A test sits beside what it tests and imports only what that file may: a script's test in `bin/` never imports `hub/`, and one that needs a hub lives in `hub/` and starts the script by its path. A test that drives a whole hub is `hub/<owner>.hub.test.ts`, on the setup in `hub/hub.testing.ts`, and the check runs those again on a store that answers late; what tests share is a `<name>.testing.ts`. The store's object also has checks on Cloudflare's runtime, `bun test ./hub/store/workerd.ts`, which fetch workerd, so CI runs them and `bin/check` doesn't.
