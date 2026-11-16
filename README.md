# FreshReadme

Status: check, regen and the execution boundary are implemented; propose, demo and the agent skill are still planned.

## Target features

FreshReadme keeps a repository's README true to the repository: it checks the whole README against the repo, regenerates marked sections from declared read-only commands, proposes evidence-backed fixes for the rest as a patch, and keeps a terminal demo GIF honest with a lock file.

References:
- https://github.com/ShreyasDasari/evergif (MIT) — idea only; all code and text original; attribution line 'Inspired by evergif (MIT)'

Requirements:
- Check every README claim against the current repository state and report each one as verified, mismatch or unverifiable.
- Regenerate only the marked README regions, from declared read-only commands; never rewrite the README outside markers.
- Propose evidence-backed changes to prose outside the markers as a patch only; the README itself is not modified.
- Keep a terminal demo GIF honest with a lock file.

Target features become usable only after the corresponding slice is implemented and
verified against its seeded issue and milestone acceptance criteria.

## Usage

FreshReadme has no runtime dependencies. It needs:

- Node.js >=20

Run it from the repository root:

```sh
node bin/freshreadme.js --help
```

<!-- freshreadme:begin usage -->
    Usage: freshreadme <command> [options]

    Commands:
      check [--json] [--format text|github]   check every README claim against the repository
      regen [--write]                         report regions that are out of date; --write rewrites them
      --help                                  print this help

    The github format prints ::error annotations; it is the default when GITHUB_ACTIONS=true.
    Commands, regions and facts are declared in .freshreadme.json in the current directory.

    Exit codes: 0 no mismatch, 1 mismatch, 2 usage, configuration or run error.
<!-- freshreadme:end usage -->

`.freshreadme.json` declares the commands FreshReadme may run (`argv`, optional `cwd` and `timeoutMs`, and `effects: "none"`),
the regions regenerated from them, and facts that tie a README phrase to a file, either as a JSON value (`json` and `equals`) or as a substring (`contains`).
A region is the text between `<!-- freshreadme:begin <id> -->` and `<!-- freshreadme:end <id> -->` lines; `regen --write` rewrites only that text.
A line in a `sh` code block runs only when it equals a declared command's argv joined by spaces; any other line is reported as not allowlisted and is not run.
Prose that no fact covers is reported as needing human judgement.

effects: none is a declaration, not a guarantee: FreshReadme compares the repository tree before and after a command runs, so it misses changes made after that comparison (for example by processes the command leaves running) and changes undone before it; it is not a sandbox and does not prevent writes elsewhere.

Exit codes: 0 when nothing mismatches (unverifiable claims are reported but do not fail the check), 1 when a claim mismatches,
and 2 on a usage or configuration error or when a declared command cannot run or changes the repository tree.

CI runs the check through `npm test`, whose script is `node --test && node bin/freshreadme.js check`: the unit tests run first, then FreshReadme checks this README.
Under GitHub Actions (`GITHUB_ACTIONS=true`) each mismatch is printed as an `::error` annotation on its README line.

## clamp

`index.js` exports a small `clamp(value, min, max)` helper:

```js
import { clamp } from "./index.js";

clamp(5, 0, 10);     // 5
clamp(-3, 0, 10);    // 0
clamp(42, 0, 10);    // 10
clamp(-10, -5, -1);  // -5
clamp(7, 3, 3);      // 3
clamp(5, 10, 0);     // throws RangeError: clamp: min (10) must not be greater than max (0)
```

## Verification

These commands verify the implemented check and regen slices; they do not verify the planned features.
They are declared in `.agent-control-plane/project.json`; this list is a copy for
readers, and the manifest is the contract.

- `test` — `npm test`

## Branches

`main` carries release history. `dev` is the integration branch and the default.
Use `feature/*`, `task/*`, `fix/*`, `release/*` and `hotfix/*` for topic branches.
