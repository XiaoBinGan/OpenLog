## What this changes

<!-- One or two sentences. What was broken, or what is new? -->

## Why this approach

<!--
The reasoning is more valuable than the diff. What did you consider and reject?
Which failure mode does this guard against?
-->

## How it was verified

<!--
Not "tests pass" — say what you actually observed. Reproduced the bug first and
confirmed it is gone? Ran it against a live instance? Include the command or the
output.
-->

## Checklist

- [ ] `npm run lint:all` — 0 errors
- [ ] `npx vitest run` — full suite green
- [ ] `npm run build` — client builds
- [ ] `cd client && npx tsc -b` — types clean
- [ ] New business logic is in pure functions with tests, not buried in components
- [ ] Comments explain *why*, not *what*
