# FreshReadme — specification

## Goal

FreshReadme keeps a repository's README true to the repository: it checks the whole README against the repo, regenerates marked sections from declared read-only commands, proposes evidence-backed fixes for the rest as a patch, and keeps a terminal demo GIF honest with a lock file.

References:
- https://github.com/ShreyasDasari/evergif (MIT) — idea only; all code and text original; attribution line 'Inspired by evergif (MIT)'

Requirements:
- Check every README claim against the current repository state and report each one as verified, mismatch or unverifiable.
- Regenerate only the marked README regions, from declared read-only commands; never rewrite the README outside markers.
- Propose evidence-backed changes to prose outside the markers as a patch only; the README itself is not modified.
- Keep a terminal demo GIF honest with a lock file.

## Non-goals

- Anything the goal above does not name. A non-goal added later is a scope change and
  belongs in a decision record, not here.

## Acceptance

### Bootstrap scaffold

Every verification command below must pass at the exact head being judged.
A passing scaffold test only verifies the scaffold; it does not verify the planned product features.

- `test` — `npm test`

### Product completion

Product completion requires the seeded issues' acceptance criteria in their issue bodies
and milestone descriptions to be satisfied.
