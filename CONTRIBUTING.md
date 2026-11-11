# Contributing to OpenLog

Thanks for taking the time to contribute. This document covers the workflow and the
conventions the codebase actually enforces.

## Development setup

```bash
git clone https://github.com/XiaoBinGan/OpenLog.git
cd OpenLog
npm install
npm run dev            # backend + vite dev server
```

Node.js **22+** is required (the project uses ESM throughout).

## Before opening a pull request

All three gates must pass locally — CI runs the same commands and will block the merge
otherwise:

```bash
npm run lint:all       # 0 errors required
npx vitest run         # full suite must be green
npm run build          # production client build must succeed
```

Type checking on the client runs from inside `client/`:

```bash
cd client && npx tsc -b
```

## Code conventions

- **Business logic lives in pure functions.** Anything with branching worth testing
  (parsers, threshold checks, budget math, suppression windows, route matching) belongs
  in a module that takes inputs and returns outputs — no React, no sockets, no fs.
  Components and route handlers stay thin so the logic is testable without a DOM or a
  live server.
- **Tests sit beside the code.** `server/__tests__/` for backend, `client/src/**/*.test.ts`
  for frontend utilities.
- **Comments explain *why*, not *what*.** A comment that restates the code has negative
  value. What is worth recording: the failure that motivated a branch, the invariant being
  preserved, why the obvious approach was rejected.
- **No fabricated data.** If a value cannot be read, report the failure. Never substitute
  a placeholder, a zero, or a stale cache entry for a real reading — silent substitution
  makes correct code look broken and broken code look fine.
- **Failures degrade, they do not cascade.** A missing GPU toolchain, an unsupported
  model capability, an unreachable host — each should produce a clear, actionable message
  and leave the rest of the system working.

## Commit messages

Use a conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
The body should state the symptom, the cause, and why this fix is the right one. If you
found the bug through a specific reproduction, include it — it is the most useful part of
the message.

## Reporting bugs

Open an issue with:

1. What you expected to happen.
2. What happened instead — including the exact error text, not a paraphrase.
3. Steps to reproduce, or the minimal input that triggers it.
4. Version / commit hash and Node version.

If the bug involves a specific model or inference engine, name it. Capability differences
between engines are a common source of "works for me".

## Security

Do not open a public issue for security problems. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT License.
