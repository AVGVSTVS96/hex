# Contributing

[AGENTS.md](AGENTS.md) says how hex is put together, and [README.md](README.md) what it's for. For anything bigger than a fix, open an issue first, so we agree on the shape before you build it.

Work on a branch and open a pull request to `main`. Say what it does and the decisions it makes, so it can be reviewed in a minute. microscope reviews every pull request, and merging needs its `microscope/correctness` status; fix or answer each finding. Commits are signed, and pull requests are squash-merged with their title as the commit message, so title it as a [conventional commit](https://www.conventionalcommits.org): `type(scope): what changes, in plain words`, like `fix(update): ship hex only once no hex session is busy`.

## Check

```sh
bin/check
```

`check` builds every channel plugin and the hub and runs the tests, with [Bun](https://bun.sh) and `jq` installed. Run it before you push: every hex runs it again on `main` before `bin/update` takes a change.
