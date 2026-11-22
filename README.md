# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files, in any of four formats: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
It finds the lines each edit names at the first of three matching tiers — exact, trailing-whitespace-insensitive,
then leading-and-trailing-whitespace-insensitive with re-indentation — and writes every change or none, printing
what it changed or why it failed.

Built for the [make.fun](https://make.fun) bounty
["Build mend, one patch tool for every AI edit format"](https://make.fun/c/hidden-spec-cli-01-run-20261122)
(`hidden-spec-cli-01-run-20261122`, $100 over 10 places). `SPEC.md` is the whole contract.

## Run it

Node 22, standard library only, no install step:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; absent or `-` reads it from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which
  detects it).
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and PATCH may come in any order; `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`; nothing is written.
Exit 2 prints one line for a usage error, an unreadable patch file, an undetected format, or a parse error.

## The files

- `main.ts`: the CLI, written from scratch for this bounty. It does all of SPEC.md: the command line, the
  output and exit codes, safe paths, format detection, the four readers, three-tier matching, and the
  all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score. This entry scores
  1000 on the practice set (100 of 100 checks).
- `extra-checks.mjs`: 72 further checks written by hand from SPEC.md, covering the sentences the practice set
  does not show (no-newline handling, parse errors, moves, anchors, JSON faults, usage errors):

      node extra-checks.mjs

- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the
exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. Standard error is
never compared. Each run has 10 seconds.
