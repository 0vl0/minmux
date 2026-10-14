# Contributing to minmux

Thanks for wanting to help. The most useful thing you can do is simple: **use minmux** for your
daily work, and tell us what breaks or what's missing.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report a bug or ask for a feature

[Open an issue](https://github.com/vcmf/minmux/issues/new/choose) and pick a template:

- **Bug report** — what you did, what happened, what you expected, plus your version and OS.
- **Feature request** — the problem you're hitting and how you'd like it solved.

Security problems go to **contact@dim0.net**, not a public issue (see [SECURITY.md](SECURITY.md)).

## Send a pull request

PRs are welcome. For anything bigger than a small fix, open an issue first so we can agree on
the approach before you spend time on it.

### Setup

```
git clone https://github.com/vcmf/minmux
cd minmux
make install   # deps, native module rebuild, git hooks
make run       # dev mode, on its own dev profile
make check     # lint + tests
```

`make run` uses a separate **dev profile** (`~/.config/minmux-dev`), so it runs next to an
installed minmux without touching your settings or layout. `make help` lists every target.

### Before you open the PR

- `make fmt` then `make check` pass (the pre-commit hook runs the same lint).
- Logic goes in small pure functions with tests next to them; see [docs/TESTING.md](docs/TESTING.md).
- If you touched terminals, panes, focus, rendering or an agent integration, try it in the app —
  unit tests can't load node-pty or WebGL.
- Keep work off the terminal hot path (PTY → renderer → xterm). See [docs/PERF.md](docs/PERF.md).

### Conventions

- Filenames in kebab-case; no semicolons (Prettier handles it).
- Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org):
  `type(scope): subject`, imperative, lowercase, no trailing period —
  e.g. `fix(sidebar): keep the branch name when a pane is renamed`.

Design and decisions live in [`docs/`](docs/); start with
[ARCHITECTURE.md](docs/ARCHITECTURE.md) and [GOTCHAS.md](docs/GOTCHAS.md).

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
