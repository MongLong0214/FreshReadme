import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_TIMEOUT_MS, isInside } from './config.js';

export const EFFECTS_NOTE =
  'effects: none is a declaration, not a guarantee: FreshReadme compares the repository tree before and after a command runs, so it misses changes made after that comparison (for example by processes the command leaves running) and changes undone before it; it is not a sandbox and does not prevent writes elsewhere.';

const EXIT_CODES = { ok: 0, nonzero: 1, refused: 2, effects: 2, 'spawn-error': 2 };

const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_\w{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /npm_[A-Za-z0-9]{36}/g,
];

export const redact = (text) =>
  TOKEN_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text == null ? '' : String(text));

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// A directory entry name that survives decoding to a string, so path.join addresses the same entry.
export const isLosslessName = (name) => Buffer.from(name.toString('utf8'), 'utf8').equals(name);

const NON_UTF8 = 'ENAMEUTF8';

// A symlink's signature from its raw target bytes, hex-encoded so distinct targets never decode to the same string.
// The hex is only ever compared, never used as a path.
export const symlinkSignature = (fields, target) => `symlink:${fields}:${target.toString('hex')}`;

const readTarget = (full) => readlinkSync(full, { encoding: 'buffer' });

// Lists dir as decoded names; names that are not valid UTF-8 are counted in lossy instead.
const listNames = (dir) => {
  const names = [];
  let lossy = 0;
  for (const name of readdirSync(dir, { encoding: 'buffer' })) {
    if (isLosslessName(name)) names.push(name.toString('utf8'));
    else lossy += 1;
  }
  return { names, lossy };
};

// Records full under key (recursing into directories); a missing path is simply absent.
// Each entry is keyed on its type and mode bits, plus content hash for files and link target for symlinks.
// An entry that cannot be read is recorded as unreadable with its error code, and an unreadable directory is not recursed.
// Each unreadable entry is also pushed onto blocked as [key, full].
const record = (entries, full, key, blocked) => {
  const unreadable = (entryKey, error) => {
    if (error.code === 'ENOENT') return;
    entries.set(entryKey, `unreadable:${error.code ?? 'UNKNOWN'}`);
    blocked.push([entryKey, full]);
  };
  let stats;
  try {
    stats = lstatSync(full);
  } catch (error) {
    unreadable(key, error);
    return;
  }
  if (stats.isDirectory()) {
    let listed;
    try {
      listed = listNames(full);
    } catch (error) {
      unreadable(`${key}/`, error);
      return;
    }
    entries.set(`${key}/`, `dir:${stats.mode}`);
    if (listed.lossy > 0) unreadable(`${key}/<non-utf8 name>`, { code: NON_UTF8 });
    for (const name of listed.names) record(entries, path.join(full, name), `${key}/${name}`, blocked);
    return;
  }
  try {
    if (stats.isSymbolicLink()) {
      entries.set(key, symlinkSignature(stats.mode, readTarget(full)));
    } else if (stats.isFile()) {
      entries.set(key, `file:${stats.mode}:${sha256(full)}`);
    } else {
      entries.set(key, `other:${stats.mode}`);
    }
  } catch (error) {
    unreadable(key, error);
  }
};

const GIT_COMMON = ['config', 'packed-refs', 'refs', 'hooks', 'info'];

// The git metadata to guard. The top-level .git entry itself is always recorded (not followed), so replacing,
// deleting or retargeting it shows up; a missing one is absent and one that cannot be lstat'ed is unreadable.
// A .git directory inside the repository is recorded whole (index, objects and logs included).
// A .git symlink is recorded as a link; its target is never followed.
// A .git file is recorded with its gitdir's HEAD and its common dir's config, packed-refs, refs, hooks and info.
const gitMetadata = (root) => {
  const dotGit = path.join(root, '.git');
  const paths = [[dotGit, '.git']];
  let stats;
  try {
    stats = lstatSync(dotGit);
  } catch {
    return paths; // record() leaves a missing .git absent and records any other failure as unreadable
  }
  if (!stats.isFile()) return paths;
  let text;
  try {
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return paths; // an unreadable .git file is recorded as unreadable by the snapshot
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return paths;
  const gitdir = path.resolve(root, match[1]);
  let common = gitdir;
  try {
    common = path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    // no commondir: the gitdir is its own common dir
  }
  return [
    ...paths,
    [path.join(gitdir, 'HEAD'), '.git/HEAD'],
    ...GIT_COMMON.map((name) => [path.join(common, name), `.git/${name}`]),
  ];
};

// Every entry under the root except the top-level .git, ignored and untracked files included, plus git metadata.
// unreadable lists the keys of unreadable entries inside the root; those under an external gitdir do not count.
// The root itself is recorded as '.' from lstat of the given path (never followed or realpath'ed): its type, mode,
// dev and ino, plus its link target when it is a symlink, taken before it is listed. So a root swapped for a symlink
// or for a fresh copy shows up as changed even when everything beneath it is identical.
// A root that cannot be read or listed (gone, renamed, unreadable) gives entries null and unreadable ['.'].
const snapshot = (root) => {
  const entries = new Map();
  const blocked = [];
  let listed;
  try {
    const stats = lstatSync(root);
    const identity = `${stats.mode}:${stats.dev}:${stats.ino}`;
    if (stats.isSymbolicLink()) entries.set('.', symlinkSignature(identity, readTarget(root)));
    else entries.set('.', `${stats.isDirectory() ? 'dir' : 'other'}:${identity}`);
    listed = listNames(root);
  } catch {
    return { entries: null, unreadable: ['.'] };
  }
  if (listed.lossy > 0) {
    entries.set('./<non-utf8 name>', `unreadable:${NON_UTF8}`);
    blocked.push(['./<non-utf8 name>', root]);
  }
  for (const name of listed.names) {
    if (name !== '.git') record(entries, path.join(root, name), name, blocked);
  }
  for (const [full, key] of gitMetadata(root)) record(entries, full, key, blocked);
  const unreadable = blocked.filter(([, full]) => isInside(root, full)).map(([key]) => key);
  return { entries, unreadable };
};

const diffSnapshots = (before, after) => [
  ...[...before].flatMap(([entryPath, signature]) => {
    if (!after.has(entryPath)) return [`deleted ${entryPath}`];
    return after.get(entryPath) === signature ? [] : [`changed ${entryPath}`];
  }),
  ...[...after.keys()].filter((entryPath) => !before.has(entryPath)).map((entryPath) => `created ${entryPath}`),
];

const finish = (reason, { status = null, stdout = '', stderr = '', message }) => ({
  ok: reason === 'ok',
  exitCode: EXIT_CODES[reason],
  status,
  reason,
  stdout: redact(stdout),
  stderr: redact(stderr),
  message: redact(message),
});

const failureText = (child, timeout) => {
  if (child.error?.code === 'ETIMEDOUT') return `timed out after ${timeout}ms`;
  if (child.error) return `could not run: ${child.error.message}`;
  if (child.signal) return `was killed by ${child.signal}`;
  return 'did not report an exit status';
};

export const runDeclared = (config, commandId, { repoRoot, spawn = spawnSync } = {}) => {
  const label = `command "${commandId}"`;
  const commands = config?.commands ?? {};
  if (!Object.hasOwn(commands, commandId)) {
    return finish('refused', { message: `${label} is not declared in ${CONFIG_FILE}; only declared commands run` });
  }

  const { argv, cwd: declaredCwd = '.', timeoutMs: timeout = DEFAULT_TIMEOUT_MS } = commands[commandId];
  const root = path.resolve(repoRoot);
  // Resolved now, not at load time: an earlier command may have swapped a symlink on the way.
  let cwd = null;
  try {
    const realRoot = realpathSync(root);
    const realCwd = realpathSync(path.resolve(root, declaredCwd));
    if (isInside(realRoot, realCwd)) cwd = realCwd;
  } catch {
    // unresolvable cwd is refused below
  }
  if (cwd === null) return finish('refused', { message: `${label}: cwd resolves outside the repository` });

  const before = snapshot(root);
  if (before.unreadable.length > 0) {
    return finish('refused', {
      message: `${label}: cannot inspect the repository tree before running (${before.unreadable.join(', ')}); not run`,
    });
  }
  let child;
  let thrown;
  let threw = false;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL', // spawnSync waits for exit, so a child that ignores SIGTERM would block forever
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    });
  } catch (error) {
    thrown = error;
    threw = true;
    child = {};
  }
  const after = snapshot(root);

  const ran = !threw &&!child.error && !child.signal && typeof child.status === 'number';
  const output = { status: ran ? child.status : null, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };

  const changes = after.entries === null ? [] : diffSnapshots(before.entries, after.entries);
  if (changes.length > 0) {
    return finish('effects', { ...output, message: `${label} changed the repository tree (${changes.join(', ')}). ${EFFECTS_NOTE}` });
  }
  if (after.unreadable.length > 0) {
    return finish('effects', {
      ...output,
      message: `${label}: cannot inspect the repository tree after running (${after.unreadable.join(', ')}). ${EFFECTS_NOTE}`,
    });
  }
  if (threw) return finish('spawn-error', { ...output, message: `${label} could not run: ${thrown?.message ?? thrown}` });
  if (!ran) return finish('spawn-error', { ...output, message: `${label} ${failureText(child, timeout)}` });
  if (child.status !== 0) {
    const detail = String(output.stderr).trim() || String(output.stdout).trim();
    return finish('nonzero', { ...output, message: `${label} exited with status ${child.status}${detail ? `: ${detail}` : ''}` });
  }
  return finish('ok', { ...output, message: `${label} ran` });
};
