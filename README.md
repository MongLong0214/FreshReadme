# FreshReadme

Status: scaffold — features below are planned and are not implemented yet.

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

## Verification

These commands verify the bootstrap scaffold only; they do not verify the planned features.
They are declared in `.agent-control-plane/project.json`; this list is a copy for
readers, and the manifest is the contract.

- `test` — `npm test`

## Branches

`main` carries release history. `dev` is the integration branch and the default.
Use `feature/*`, `task/*`, `fix/*`, `release/*` and `hotfix/*` for topic branches.
