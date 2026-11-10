# Contributing

[AGENTS.md](AGENTS.md) says how hex is put together, and [README.md](README.md) what it's for. For anything bigger than a fix, open an issue first, so we agree on the shape before you build it.

Work on a branch and open a pull request to `main`. Say what it does and the decisions it makes, so a maintainer can review it in a minute. Title it as a [conventional commit](https://www.conventionalcommits.org), `type(scope): what changes, in plain words`, like `fix(update): ship hex only once no hex session is busy`: the maintainer squash-merges it under that title.

## Check

```sh
bun run check   # bun run fix formats
```

`check` checks the formatting ([oxfmt](https://oxc.rs/docs/guide/usage/formatter)), then runs `bin/check`, which builds every channel plugin and the hub and runs the tests, with [Bun](https://bun.sh) and `jq` installed. CI runs it on every pull request, and every hex runs `bin/check` again on `main` before `bin/update` takes a change.
