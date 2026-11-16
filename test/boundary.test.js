import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/check.js';
import { CONFIG_FILE, loadConfig } from '../src/config.js';
import { regen } from '../src/regen.js';
import { EFFECTS_NOTE, isLosslessName, redact, runDeclared, symlinkSignature } from '../src/runner.js';

const node = process.execPath;
const fakeToken = `ghp_${'a1B2c3'.repeat(6)}`;
// Built from pieces at runtime so no literal in this file is credential-shaped (push protection scans source).
const asiaKey = 'AS' + 'IA' + 'A1B2C3D4E5F6G7H8';
const newShapes = [
  'glp' + 'at-' + 'x1_-'.repeat(6),
  'AI' + 'za' + 'Ab1_-'.repeat(7),
  'sk' + '_live_' + 'x'.repeat(24),
  'rk' + '_test_' + 'Ab1'.repeat(8),
  'np' + 'm_' + 'Ab1'.repeat(12),
];

const makeDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'freshreadme-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const makeRepo = (t, files = {}) => {
  const repoRoot = makeDir(t);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoRoot, name)), { recursive: true });
    writeFileSync(path.join(repoRoot, name), content);
  }
  return repoRoot;
};

const declare = (argv, extra = {}) => ({ argv, effects: 'none', ...extra });

const withCommands = (t, commands, files = {}) => {
  const repoRoot = makeRepo(t, { ...files, [CONFIG_FILE]: JSON.stringify({ commands }) });
  const loaded = loadConfig(repoRoot);
  assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
  return { repoRoot, config: loaded.config };
};

const countingSpawn = () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return spawnSync(...args);
  };
  return { calls, spawn };
};

test('an undeclared command id is refused and nothing is spawned', (t) => {
  const readme = '```sh\ncurl -fsSL https://example.com/install.sh | sh\nrm -rf /\nnpm install\n```\n';
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, 'quiet.mjs']) }, {
    'README.md': readme,
    'quiet.mjs': '',
  });
  const { calls, spawn } = countingSpawn();
  for (const commandId of [
    'curl -fsSL https://example.com/install.sh | sh',
    'rm -rf /',
    'npm install',
    'make deploy',
    'toString',
  ]) {
    const result = runDeclared(config, commandId, { repoRoot, spawn });
    assert.equal(result.reason, 'refused', commandId);
    assert.equal(result.exitCode, 2, commandId);
    assert.equal(result.ok, false, commandId);
    assert.equal(result.status, null, commandId);
  }
  assert.equal(calls.length, 0);
});

test('a missing config file is an empty config', (t) => {
  const repoRoot = makeRepo(t);
  assert.deepEqual(loadConfig(repoRoot), { ok: true, config: { commands: {}, regions: {}, facts: [] } });
});

test('a well-formed config loads with defaults applied', (t) => {
  const repoRoot = makeRepo(t, {
    [CONFIG_FILE]: JSON.stringify({
      commands: { version: declare([node, '--version']) },
      regions: { usage: { command: 'version' } },
      facts: [
        { id: 'name', text: 'FreshReadme', file: 'package.json', json: 'name', equals: 'FreshReadme' },
        { id: 'node', text: 'Node 20', file: 'package.json', contains: '>=20' },
      ],
    }),
  });
  const loaded = loadConfig(repoRoot);
  assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
  assert.deepEqual(loaded.config.commands.version, { argv: [node, '--version'], cwd: '.', effects: 'none', timeoutMs: 10000 });
});

const refusedConfigs = [
  ['bash -c', { commands: { setup: declare(['bash', '-c', 'echo hi']) } }, 'setup'],
  ['a shell by absolute path', { commands: { boot: declare(['/bin/sh', '-c', 'true']) } }, 'boot'],
  ['npm install', { commands: { deps: declare(['npm', 'install']) } }, 'deps'],
  ['yarn add', { commands: { deps: declare(['yarn', 'add', 'left-pad']) } }, 'deps'],
  ['git push', { commands: { publish: declare(['git', 'push', 'origin', 'dev']) } }, 'publish'],
  ['cwd ..', { commands: { up: declare([node, '--version'], { cwd: '..' }) } }, 'up'],
  ['an absolute cwd', { commands: { abs: declare([node, '--version'], { cwd: tmpdir() }) } }, 'abs'],
  ['an empty argv', { commands: { none: declare([]) } }, 'none'],
  ['an empty-string argv element', { commands: { blank: declare([node, '-e', '']) } }, 'blank'],
  ['effects other than none', { commands: { write: { argv: [node, '--version'], effects: 'writes' } } }, 'write'],
  ['a non-positive timeout', { commands: { slow: declare([node, '--version'], { timeoutMs: 0 }) } }, 'slow'],
  ['a fractional timeout', { commands: { frac: declare([node, '--version'], { timeoutMs: 0.5 }) } }, 'frac'],
  ['an argv element containing NUL', { commands: { nul: declare([node, '-e', 'a\u0000b']) } }, 'nul'],
  ['a region naming an undeclared command', { commands: {}, regions: { usage: { command: 'missing' } } }, 'missing'],
  ['a fact with both forms', { facts: [{ id: 'both', text: 'x', file: 'a.json', json: 'a', equals: 'b', contains: 'c' }] }, 'both'],
  ['a fact without a file', { facts: [{ id: 'nofile', text: 'x', contains: 'c' }] }, 'nofile'],
];

for (const [name, config, id] of refusedConfigs) {
  test(`loadConfig refuses ${name}`, (t) => {
    const repoRoot = makeRepo(t, { [CONFIG_FILE]: JSON.stringify(config) });
    const result = loadConfig(repoRoot);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.ok(result.errors.some((error) => error.includes(`"${id}"`)), result.errors.join('\n'));
  });
}

const nonStringRegionCommands = [
  ['an object without toString or valueOf', { toString: null, valueOf: null }],
  ['null', null],
  ['an array', ['version']],
  ['a number', 1],
  ['the empty string', ''],
];

for (const [name, command] of nonStringRegionCommands) {
  test(`loadConfig refuses a region command that is ${name}`, (t) => {
    const repoRoot = makeRepo(t, {
      [CONFIG_FILE]: JSON.stringify({ commands: { version: declare([node, '--version']) }, regions: { usage: { command } } }),
    });
    let result;
    assert.doesNotThrow(() => {
      result = loadConfig(repoRoot);
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.errors, ['region "usage": command must be a non-empty string']);
  });
}

test('check exits 2 without spawning when a region command is an object', (t) => {
  const repoRoot = makeRepo(t, {
    'README.md': '<!-- freshreadme:begin usage -->\n<!-- freshreadme:end usage -->\n',
    [CONFIG_FILE]: JSON.stringify({
      commands: { version: declare([node, '--version']) },
      regions: { usage: { command: { toString: null, valueOf: null } } },
    }),
  });
  const { calls, spawn } = countingSpawn();
  let report;
  assert.doesNotThrow(() => {
    report = check({ repoRoot, spawn });
  });
  assert.equal(report.exitCode, 2);
  assert.deepEqual(report.errors, ['region "usage": command must be a non-empty string']);
  assert.equal(calls.length, 0);
});

const nonStringFactIds = [
  ['an object without toString', { toString: null }],
  ['null', null],
  ['an array', ['name']],
  ['a number', 1],
];

for (const [name, id] of nonStringFactIds) {
  test(`loadConfig refuses a fact id that is ${name}`, (t) => {
    const repoRoot = makeRepo(t, {
      [CONFIG_FILE]: JSON.stringify({ facts: [{ id, text: 'FreshReadme', file: 'package.json', contains: 'x' }] }),
    });
    let result;
    assert.doesNotThrow(() => {
      result = loadConfig(repoRoot);
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.errors, ['fact 0: id must be a non-empty string']);
  });
}

test('check and regen exit 2 without a stack trace or a spawn when a fact id is an object', (t) => {
  const bin = fileURLToPath(new URL('../bin/freshreadme.js', import.meta.url));
  const readme = '# demo\n\n<!-- freshreadme:begin out -->\n<!-- freshreadme:end out -->\n';
  const repoRoot = makeRepo(t, {
    'README.md': readme,
    'make.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('made.txt', 'x');\n",
    [CONFIG_FILE]: JSON.stringify({
      commands: { make: declare([node, 'make.mjs']) },
      regions: { out: { command: 'make' } },
      facts: [{ id: { toString: null }, text: 'demo', file: 'README.md', contains: 'demo' }],
    }),
  });
  for (const command of ['check', 'regen']) {
    const child = spawnSync(node, [bin, command], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
    const output = `${child.stdout}${child.stderr}`;
    assert.equal(child.status, 2, output);
    assert.ok(output.includes('error: fact 0: id must be a non-empty string'), output);
    assert.doesNotMatch(output, /^\s+at /m);
    assert.equal(existsSync(path.join(repoRoot, 'made.txt')), false, command);
    assert.equal(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), readme, command);
  }
});

test('loadConfig refuses a cwd that is a symlink to a directory outside the repository', (t) => {
  const outside = makeDir(t);
  const repoRoot = makeRepo(t, { [CONFIG_FILE]: JSON.stringify({ commands: { out: declare([node, '--version'], { cwd: 'linked' }) } }) });
  symlinkSync(outside, path.join(repoRoot, 'linked'), 'dir');
  const result = loadConfig(repoRoot);
  assert.equal(result.exitCode, 2);
  assert.ok(result.errors.some((error) => error.includes('"out"') && error.includes('outside')), result.errors.join('\n'));
});

test('a cwd symlink swapped by an earlier command is refused before spawning', (t) => {
  const outside = makeDir(t);
  const repoRoot = makeRepo(t, {
    'work/keep.txt': '',
    'swap.mjs': "import { symlinkSync, unlinkSync } from 'node:fs';\nunlinkSync('link');\nsymlinkSync(process.argv[2], 'link', 'dir');\n",
    [CONFIG_FILE]: JSON.stringify({
      commands: { swap: declare([node, 'swap.mjs', outside]), probe: declare([node, '--version'], { cwd: 'link' }) },
    }),
  });
  symlinkSync('work', path.join(repoRoot, 'link'), 'dir');
  const loaded = loadConfig(repoRoot);
  assert.equal(loaded.ok, true, loaded.errors?.join('\n'));

  const swapped = runDeclared(loaded.config, 'swap', { repoRoot });
  assert.equal(swapped.reason, 'effects', swapped.message);

  const { calls, spawn } = countingSpawn();
  const probed = runDeclared(loaded.config, 'probe', { repoRoot, spawn });
  assert.equal(probed.reason, 'refused', probed.message);
  assert.equal(probed.exitCode, 2);
  assert.ok(probed.message.includes('outside the repository'), probed.message);
  assert.equal(calls.length, 0);
});

const gitFiles = { '.git/config': '[core]\n', '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${'a'.repeat(40)}\n` };
const gitScript = (body) => `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n${body}\n`;

const gitWriters = [
  ['appends to .git/config', "appendFileSync('.git/config', '[alias]\\n');", 'changed .git/config'],
  ['writes a new ref', "writeFileSync('.git/refs/heads/probe', 'x');", 'created .git/refs/heads/probe'],
];

for (const [name, body, change] of gitWriters) {
  test(`a command that ${name} trips the effects guard`, (t) => {
    const { repoRoot, config } = withCommands(t, { git: declare([node, 'git.mjs']) }, { ...gitFiles, 'git.mjs': gitScript(body) });
    const result = runDeclared(config, 'git', { repoRoot });
    assert.equal(result.reason, 'effects', result.message);
    assert.equal(result.exitCode, 2);
    assert.ok(result.message.includes(change), result.message);
    assert.ok(result.message.endsWith(EFFECTS_NOTE), result.message);
  });
}

test('writes to .git/index and .git/objects trip the effects guard', (t) => {
  const body = "writeFileSync('.git/index', 'x');\nmkdirSync('.git/objects/ab', { recursive: true });\nwriteFileSync('.git/objects/ab/cdef', 'x');";
  const { repoRoot, config } = withCommands(t, { read: declare([node, 'read.mjs']) }, { ...gitFiles, 'read.mjs': gitScript(body) });
  const result = runDeclared(config, 'read', { repoRoot });
  assert.equal(result.reason, 'effects', result.message);
  assert.equal(result.exitCode, 2);
  assert.ok(result.message.includes('created .git/index'), result.message);
  assert.ok(result.message.includes('created .git/objects/ab/cdef'), result.message);
});

const asRoot = process.getuid?.() === 0;

test('a tree directory that cannot be listed is refused before spawning', (t) => {
  if (asRoot) {
    t.skip('root ignores directory permissions');
    return;
  }
  const { repoRoot, config } = withCommands(t, { write: declare([node, 'write.mjs']) }, {
    'locked/keep.txt': '',
    'write.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('locked/new.txt', 'x');\n",
  });
  const locked = path.join(repoRoot, 'locked');
  chmodSync(locked, 0o300);
  try {
    const { calls, spawn } = countingSpawn();
    const result = runDeclared(config, 'write', { repoRoot, spawn });
    assert.equal(result.reason, 'refused', result.message);
    assert.equal(result.exitCode, 2);
    assert.ok(result.message.includes('locked/'), result.message);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(path.join(locked, 'new.txt')), false);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('a command that leaves a tree directory unlistable is not ok and check does not verify it', (t) => {
  if (asRoot) {
    t.skip('root ignores directory permissions');
    return;
  }
  const argv = [node, 'lock.mjs'];
  const repoRoot = makeRepo(t, {
    'README.md': `\`\`\`sh\n${argv.join(' ')}\n\`\`\`\n`,
    'locked/keep.txt': '',
    'lock.mjs': "import { chmodSync } from 'node:fs';\nchmodSync('locked', 0o300);\n",
    [CONFIG_FILE]: JSON.stringify({ commands: { lock: declare(argv) } }),
  });
  const locked = path.join(repoRoot, 'locked');
  try {
    const loaded = loadConfig(repoRoot);
    assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
    const result = runDeclared(loaded.config, 'lock', { repoRoot });
    assert.equal(result.exitCode, 2, result.message);
    assert.equal(result.ok, false);

    // The directory is now unlistable, so running the same command again must not verify it.
    const report = check({ repoRoot });
    assert.equal(report.exitCode, 2, report.errors.join('\n'));
    assert.equal(report.fullyVerified, false);
    const claim = report.claims.find((entry) => entry.class === 'command');
    assert.ok(claim, JSON.stringify(report.claims));
    assert.notEqual(claim.status, 'verified', claim.detail);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('isLosslessName rejects names that are not valid UTF-8', () => {
  assert.equal(isLosslessName(Buffer.from([0xff])), false);
  assert.equal(isLosslessName(Buffer.from('README.md')), true);
  assert.equal(isLosslessName(Buffer.from('é.txt')), true);
});

// A repository with one declared command, cleaned up with the non-UTF-8 name removed by its bytes first,
// since string-based removal cannot address it. Returns { refused } when the filesystem refuses such names.
const withNonUtf8 = (t, script) => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'freshreadme-boundary-'));
  const badName = Buffer.concat([Buffer.from(`${repoRoot}${path.sep}`), Buffer.from([0xff])]);
  t.after(() => {
    rmSync(badName, { force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  try {
    writeFileSync(badName, 'x');
  } catch (error) {
    return { refused: error.code ?? String(error) };
  }
  writeFileSync(path.join(repoRoot, 'run.mjs'), script);
  writeFileSync(path.join(repoRoot, CONFIG_FILE), JSON.stringify({ commands: { run: declare([node, 'run.mjs']) } }));
  const loaded = loadConfig(repoRoot);
  assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
  return { repoRoot, badName, config: loaded.config };
};

test('a command that creates a file with a non-UTF-8 name is not ok', (t) => {
  const repo = withNonUtf8(t, "import { writeFileSync } from 'node:fs';\nwriteFileSync(Buffer.from([0xff]), 'x');\n");
  if (repo.refused) {
    t.skip(`filesystem refuses non-UTF-8 names (${repo.refused})`);
    return;
  }
  rmSync(repo.badName);
  const result = runDeclared(repo.config, 'run', { repoRoot: repo.repoRoot });
  assert.equal(result.exitCode, 2, result.message);
  assert.equal(result.ok, false);
  assert.equal(existsSync(repo.badName), true, 'the command created the file');
});

test('a repository holding a non-UTF-8 name is refused before spawning', (t) => {
  const repo = withNonUtf8(t, '');
  if (repo.refused) {
    t.skip(`filesystem refuses non-UTF-8 names (${repo.refused})`);
    return;
  }
  const { calls, spawn } = countingSpawn();
  const result = runDeclared(repo.config, 'run', { repoRoot: repo.repoRoot, spawn });
  assert.equal(result.reason, 'refused', result.message);
  assert.equal(result.exitCode, 2);
  assert.equal(calls.length, 0);
});

test('a command that retargets a symlink between non-UTF-8 targets is not ok', (t) => {
  const script =
    "import { symlinkSync, unlinkSync } from 'node:fs';\nunlinkSync('l');\nsymlinkSync(Buffer.from([0x81]), 'l');\n";
  const { repoRoot, config } = withCommands(t, { retarget: declare([node, 'retarget.mjs']) }, { 'retarget.mjs': script });
  const link = path.join(repoRoot, 'l');
  const probe = path.join(repoRoot, 'probe');
  try {
    symlinkSync(Buffer.from([0x81]), probe);
    rmSync(probe);
    symlinkSync(Buffer.from([0x80]), link);
  } catch (error) {
    t.skip(`filesystem refuses non-UTF-8 symlink targets (${error.code ?? String(error)})`);
    return;
  }
  const result = runDeclared(config, 'retarget', { repoRoot });
  assert.equal(result.exitCode, 2, result.message);
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('changed l'), result.message);
});

test('an unchanged UTF-8 symlink with a no-op command is ok', (t) => {
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, 'quiet.mjs']) }, { 'README.md': '# demo\n', 'quiet.mjs': '' });
  symlinkSync('README.md', path.join(repoRoot, 'l2'));
  const result = runDeclared(config, 'quiet', { repoRoot });
  assert.equal(result.reason, 'ok', result.message);
  assert.equal(result.ok, true);
});

test('symlinkSignature distinguishes raw targets that decode to the same string', () => {
  const [a, b] = [Buffer.from([0x80]), Buffer.from([0x81])];
  assert.equal(a.toString('utf8'), b.toString('utf8'));
  assert.notEqual(symlinkSignature(0o120755, a), symlinkSignature(0o120755, b));
});

test('a command that rewrites the config of a .git file gitdir trips the effects guard', (t) => {
  const gitdir = makeDir(t);
  writeFileSync(path.join(gitdir, 'config'), '[core]\n');
  writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
  const body = "writeFileSync(process.argv[2] + '/config', '[core]\\n\\tfsmonitor = evil\\n');";
  const { repoRoot, config } = withCommands(t, { git: declare([node, 'git.mjs', gitdir]) }, {
    '.git': `gitdir: ${gitdir}\n`,
    'git.mjs': gitScript(body),
  });
  const result = runDeclared(config, 'git', { repoRoot });
  assert.equal(result.reason, 'effects', result.message);
  assert.ok(result.message.includes('changed .git/config'), result.message);
});

test('an unreadable .git file gitdir does not throw and a no-op command is ok', (t) => {
  const gitdir = mkdtempSync(path.join(tmpdir(), 'freshreadme-gitdir-'));
  t.after(() => {
    chmodSync(gitdir, 0o755);
    rmSync(gitdir, { recursive: true, force: true });
  });
  writeFileSync(path.join(gitdir, 'config'), '[core]\n');
  writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, 'quiet.mjs']) }, {
    '.git': `gitdir: ${gitdir}\n`,
    'quiet.mjs': '',
  });
  chmodSync(gitdir, 0o000);
  let result;
  assert.doesNotThrow(() => {
    result = runDeclared(config, 'quiet', { repoRoot });
  });
  assert.equal(result.reason, 'ok', result.message);
});

const linkScript = (body) => `import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';\n${body}\n`;

const withGitLink = (t, body) => {
  const target = makeDir(t);
  const other = makeDir(t);
  const argv = [node, 'link.mjs', other];
  const { repoRoot, config } = withCommands(t, { link: declare(argv) }, { 'link.mjs': linkScript(body) });
  symlinkSync(target, path.join(repoRoot, '.git'), 'dir');
  return { repoRoot, config, argv };
};

test('a no-op command with a symlinked .git is ok', (t) => {
  const { repoRoot, config } = withGitLink(t, '');
  const result = runDeclared(config, 'link', { repoRoot });
  assert.equal(result.reason, 'ok', result.message);
});

const gitLinkWriters = [
  ['retargets the .git symlink', "unlinkSync('.git');\nsymlinkSync(process.argv[2], '.git', 'dir');", 'changed .git'],
  ['deletes the .git symlink', "unlinkSync('.git');", 'deleted .git'],
  ['replaces the .git symlink with a directory', "unlinkSync('.git');\nmkdirSync('.git');", 'deleted .git'],
];

for (const [name, body, change] of gitLinkWriters) {
  test(`a command that ${name} trips the effects guard`, (t) => {
    const { repoRoot, config } = withGitLink(t, body);
    const result = runDeclared(config, 'link', { repoRoot });
    assert.equal(result.reason, 'effects', result.message);
    assert.equal(result.exitCode, 2);
    assert.ok(result.message.includes(change), result.message);
    assert.ok(result.message.endsWith(EFFECTS_NOTE), result.message);
  });
}

test('check does not verify a README command that retargets the .git symlink', (t) => {
  const body = "unlinkSync('.git');\nsymlinkSync(process.argv[2], '.git', 'dir');";
  const target = makeDir(t);
  const other = makeDir(t);
  const argv = [node, 'link.mjs', other];
  const repoRoot = makeRepo(t, {
    'README.md': `\`\`\`sh\n${argv.join(' ')}\n\`\`\`\n`,
    'link.mjs': linkScript(body),
    [CONFIG_FILE]: JSON.stringify({ commands: { link: declare(argv) } }),
  });
  symlinkSync(target, path.join(repoRoot, '.git'), 'dir');
  const report = check({ repoRoot });
  assert.equal(report.exitCode, 2, report.errors.join('\n'));
  assert.equal(report.fullyVerified, false);
  const claim = report.claims.find((entry) => entry.class === 'command');
  assert.ok(claim, JSON.stringify(report.claims));
  assert.notEqual(claim.status, 'verified', claim.detail);
});

// A repository inside its own temp parent, with a declared command that renames or deletes the repository root.
// Removing the parent cleans up both the original and the moved path; the product restores nothing.
const rootLosers = {
  rename: "import { renameSync } from 'node:fs';\nrenameSync(process.argv[2], process.argv[3]);\n",
  delete: "import { rmSync } from 'node:fs';\nrmSync(process.argv[2], { recursive: true, force: true });\n",
};

const withRootLoss = (t, mode) => {
  const parent = makeDir(t);
  const repoRoot = path.join(parent, 'repo');
  const moved = path.join(parent, 'moved');
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  });
  const argv = [node, path.join(repoRoot, 'lose.mjs'), repoRoot, moved];
  mkdirSync(repoRoot);
  writeFileSync(path.join(repoRoot, 'lose.mjs'), rootLosers[mode]);
  writeFileSync(
    path.join(repoRoot, 'README.md'),
    `\`\`\`sh\n${argv.join(' ')}\n\`\`\`\n\n<!-- freshreadme:begin out -->\n<!-- freshreadme:end out -->\n`,
  );
  writeFileSync(path.join(repoRoot, CONFIG_FILE), JSON.stringify({ commands: { lose: declare(argv) }, regions: { out: { command: 'lose' } } }));
  return repoRoot;
};

for (const mode of Object.keys(rootLosers)) {
  test(`a command that ${mode}s the repository root is not ok and does not throw`, (t) => {
    const repoRoot = withRootLoss(t, mode);
    const loaded = loadConfig(repoRoot);
    assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
    let result;
    assert.doesNotThrow(() => {
      result = runDeclared(loaded.config, 'lose', { repoRoot });
    });
    assert.equal(result.exitCode, 2, result.message);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'effects', result.message);
    assert.ok(result.message.includes('cannot inspect the repository tree after running (.)'), result.message);
  });

  test(`check and regen exit 2 without throwing when a command ${mode}s the repository root`, (t) => {
    let report;
    assert.doesNotThrow(() => {
      report = check({ repoRoot: withRootLoss(t, mode) });
    });
    assert.equal(report.exitCode, 2, report.errors.join('\n'));
    assert.equal(report.fullyVerified, false);

    let regenerated;
    assert.doesNotThrow(() => {
      regenerated = regen({ repoRoot: withRootLoss(t, mode) });
    });
    assert.equal(regenerated.exitCode, 2, regenerated.errors.join('\n'));
  });
}

test('a repository root that cannot be listed is refused before spawning', (t) => {
  if (asRoot) {
    t.skip('root ignores directory permissions');
    return;
  }
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, '--version']) });
  chmodSync(repoRoot, 0o100);
  try {
    const { calls, spawn } = countingSpawn();
    let result;
    assert.doesNotThrow(() => {
      result = runDeclared(config, 'quiet', { repoRoot, spawn });
    });
    assert.equal(result.reason, 'refused', result.message);
    assert.equal(result.exitCode, 2);
    assert.equal(result.message, 'command "quiet": cannot inspect the repository tree before running (.); not run');
    assert.equal(calls.length, 0);
  } finally {
    chmodSync(repoRoot, 0o755);
  }
});

test('a command that chmods the repository root trips the effects guard, and a no-op is ok', (t) => {
  const { repoRoot, config } = withCommands(t, {
    lock: declare([node, 'lock.mjs']),
    quiet: declare([node, 'quiet.mjs']),
  }, {
    'lock.mjs': "import { chmodSync } from 'node:fs';\nchmodSync('.', 0o555);\n",
    'quiet.mjs': '',
  });
  try {
    const quiet = runDeclared(config, 'quiet', { repoRoot });
    assert.equal(quiet.reason, 'ok', quiet.message);

    const result = runDeclared(config, 'lock', { repoRoot });
    assert.equal(result.reason, 'effects', result.message);
    assert.equal(result.exitCode, 2);
    assert.ok(result.message.includes('(changed .)'), result.message);
  } finally {
    chmodSync(repoRoot, 0o755);
  }
});

// Declared commands that move the repository to a sibling path and put something identical-looking at the original path.
const rootSwappers = {
  'a symlink to the moved repository': [
    "import { renameSync, symlinkSync } from 'node:fs';",
    'const [from, to] = process.argv.slice(2);',
    'renameSync(from, to);',
    "symlinkSync(to, from, 'dir');",
  ],
  'a fresh directory with byte-identical copies': [
    "import { chmodSync, copyFileSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';",
    "import path from 'node:path';",
    'const [from, to] = process.argv.slice(2);',
    'renameSync(from, to);',
    'const copy = (src, dst) => {',
    '  const stats = statSync(src);',
    '  if (stats.isDirectory()) {',
    '    mkdirSync(dst);',
    '    for (const name of readdirSync(src)) copy(path.join(src, name), path.join(dst, name));',
    '  } else copyFileSync(src, dst);',
    '  chmodSync(dst, stats.mode & 0o7777);',
    '};',
    'copy(to, from);',
  ],
};

for (const [name, lines] of Object.entries(rootSwappers)) {
  test(`a command that replaces the repository root with ${name} trips the effects guard, and a no-op is ok`, (t) => {
    const parent = makeDir(t);
    const repoRoot = path.join(parent, 'repo');
    const moved = path.join(parent, 'moved');
    t.after(() => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    });
    mkdirSync(repoRoot);
    writeFileSync(path.join(repoRoot, 'swap.mjs'), `${lines.join('\n')}\n`);
    writeFileSync(path.join(repoRoot, 'quiet.mjs'), '');
    writeFileSync(path.join(repoRoot, 'README.md'), '# demo\n');
    writeFileSync(
      path.join(repoRoot, CONFIG_FILE),
      JSON.stringify({
        commands: { swap: declare([node, path.join(repoRoot, 'swap.mjs'), repoRoot, moved]), quiet: declare([node, 'quiet.mjs']) },
      }),
    );
    const loaded = loadConfig(repoRoot);
    assert.equal(loaded.ok, true, loaded.errors?.join('\n'));

    const quiet = runDeclared(loaded.config, 'quiet', { repoRoot });
    assert.equal(quiet.reason, 'ok', quiet.message);

    const result = runDeclared(loaded.config, 'swap', { repoRoot });
    assert.equal(result.reason, 'effects', result.message);
    assert.equal(result.exitCode, 2);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('(changed .)'), result.message);
    assert.ok(existsSync(path.join(moved, 'README.md')), 'the command moved the repository');
  });
}

test('a spawn that throws is a spawn error', (t) => {
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, '--version']) });
  const spawn = () => {
    throw new Error('boom');
  };
  const result = runDeclared(config, 'quiet', { repoRoot, spawn });
  assert.equal(result.reason, 'spawn-error');
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, null);
  assert.equal(result.message, 'command "quiet" could not run: boom');
});

test('check exits 2 without a stack trace on a fractional timeout', (t) => {
  const bin = fileURLToPath(new URL('../bin/freshreadme.js', import.meta.url));
  const repoRoot = makeRepo(t, {
    'README.md': '# demo\n',
    [CONFIG_FILE]: JSON.stringify({ commands: { frac: declare([node, '--version'], { timeoutMs: 0.5 }) } }),
  });
  const child = spawnSync(node, [bin, 'check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(child.status, 2, child.stderr);
  assert.doesNotMatch(child.stderr, /^\s+at /m);
});

test('a parent environment variable is absent in the child', (t) => {
  const name = 'FRESHREADME_BOUNDARY_PARENT_ONLY';
  process.env[name] = 'parent-value';
  t.after(() => delete process.env[name]);
  const { repoRoot, config } = withCommands(t, { env: declare([node, 'env.mjs']) }, {
    'env.mjs': 'process.stdout.write(JSON.stringify(process.env));\n',
  });
  const result = runDeclared(config, 'env', { repoRoot });
  assert.equal(result.reason, 'ok', result.message);
  const env = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(env, name), false);
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.PATH, process.env.PATH);
});

test('a command that writes nothing passes the effects guard', (t) => {
  const { repoRoot, config } = withCommands(t, { quiet: declare([node, 'quiet.mjs']) }, { 'quiet.mjs': '' });
  const { calls, spawn } = countingSpawn();
  const result = runDeclared(config, 'quiet', { repoRoot, spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(result, { ok: true, exitCode: 0, status: 0, reason: 'ok', stdout: '', stderr: '', message: 'command "quiet" ran' });
});

const writers = [
  ['creates a tracked file', "writeFileSync('notes.md', 'x');", 'created notes.md', {}],
  ['creates an ignored file', "writeFileSync('debug.log', 'x');", 'created debug.log', { '.gitignore': '*.log\n' }],
  ['changes an existing file', "appendFileSync('README.md', 'more');", 'changed README.md', {}],
  ['deletes a file', "rmSync('README.md');", 'deleted README.md', {}],
  ['chmods a tracked file', "chmodSync('README.md', 0o755);", 'changed README.md', {}],
  [
    'rewrites a file with same-size content and restores its mtime',
    "const { atime, mtime } = statSync('README.md');\nwriteFileSync('README.md', '# DEMO\\n');\nutimesSync('README.md', atime, mtime);",
    'changed README.md',
    {},
  ],
  ['creates an empty directory', "mkdirSync('empty');", 'created empty/', {}],
];

for (const [name, body, change, files] of writers) {
  test(`a command that ${name} trips the effects guard`, (t) => {
    const script = `import { appendFileSync, chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';\n${body}\n`;
    const { repoRoot, config } = withCommands(t, { write: declare([node, 'write.mjs']) }, {
      ...files,
      'README.md': '# demo\n',
      'write.mjs': script,
    });
    const result = runDeclared(config, 'write', { repoRoot });
    assert.equal(result.reason, 'effects');
    assert.equal(result.exitCode, 2);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(change), result.message);
    assert.ok(result.message.endsWith(EFFECTS_NOTE), result.message);
  });
}

test('token-shaped output is redacted from stdout, stderr and message', (t) => {
  const script = `console.log('token=${fakeToken}');\nconsole.error('${fakeToken}');\nprocess.exit(Number(process.argv[2]));\n`;
  const secrets = [asiaKey, ...newShapes];
  const { repoRoot, config } = withCommands(t, {
    pass: declare([node, 'leak.mjs', '0']),
    fail: declare([node, 'leak.mjs', '1']),
    shapes: declare([node, 'shapes.mjs', ...secrets]),
  }, {
    'leak.mjs': script,
    'shapes.mjs': "const values = process.argv.slice(2);\nconsole.log(values.join(' '));\nconsole.error(values.join('\\n'));\nprocess.exit(1);\n",
  });

  const shaped = runDeclared(config, 'shapes', { repoRoot });
  assert.equal(shaped.reason, 'nonzero', shaped.message);
  assert.ok(shaped.message.includes('[redacted]'), shaped.message);
  for (const field of ['stdout', 'stderr', 'message']) {
    for (const secret of secrets) assert.equal(shaped[field].includes(secret), false, `${field}: ${secret}`);
  }

  const passed = runDeclared(config, 'pass', { repoRoot });
  assert.equal(passed.reason, 'ok', passed.message);
  assert.equal(passed.stdout, 'token=[redacted]\n');
  assert.equal(passed.stderr, '[redacted]\n');

  const failed = runDeclared(config, 'fail', { repoRoot });
  assert.equal(failed.reason, 'nonzero');
  assert.ok(failed.message.includes('[redacted]'), failed.message);

  for (const result of [passed, failed]) {
    for (const field of ['stdout', 'stderr', 'message']) {
      assert.equal(result[field].includes(fakeToken), false, field);
    }
  }
});

test('redact replaces each token shape', () => {
  const samples = [
    ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((prefix) => `${prefix}_${'Ab1'.repeat(8)}`),
    `github_pat_${'a1_'.repeat(10)}`,
    `sk-${'ab-_12'.repeat(4)}`,
    `xoxb-${'1234567890'}-${'abcdefABCDEF'}`,
    `AKIA${'ABCDEFGHIJ123456'}`,
    asiaKey,
    `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxIn0'}.${'c2lnbmF0dXJl'}`,
    `-----BEGIN ${'RSA PRIVATE KEY'}-----\n${'MIIBVQ'}\n-----END ${'RSA PRIVATE KEY'}-----`,
    ...newShapes,
  ];
  for (const sample of samples) {
    assert.equal(redact(`before ${sample} after`), 'before [redacted] after', sample);
  }
  assert.equal(redact('ghp_short and sk-tiny'), 'ghp_short and sk-tiny');
  // A word character before sk- no longer protects it: this is the same shape as 'prefix' + an sk- key.
  assert.equal(redact('task-abcdefghijklmnopqrstuvwxyz'), 'ta[redacted]');
});

// Each built at runtime, as above.
const prefixedShapes = ['sk' + '-' + 'Ab1_-'.repeat(5), 'sk' + '_live_' + 'Ab1'.repeat(8), 'np' + 'm_' + 'Ab1'.repeat(12)];
const positions = [(token) => token, (token) => 'prefix' + token, (token) => 'x:' + token];
const leakLines = prefixedShapes.flatMap((token) => positions.map((place) => place(token)));
const redactedLines = prefixedShapes.flatMap(() => positions.map((place) => place('[redacted]')));
const leakScript = `const lines = ${JSON.stringify(leakLines)};\nconsole.log(lines.join('\\n'));\nprocess.exit(Number(process.argv[2]));\n`;

test('redact replaces a credential after a word character, after punctuation and at string start', () => {
  for (const token of prefixedShapes) {
    for (const place of positions) assert.equal(redact(place(token)), place('[redacted]'), place(token));
  }
});

test('check diagnostics and regen --write redact a credential that follows a word character', (t) => {
  const bin = fileURLToPath(new URL('../bin/freshreadme.js', import.meta.url));
  const env = { ...process.env, GITHUB_ACTIONS: 'false' };
  const argv = [node, 'leak.mjs', '1'];
  const checkRoot = makeRepo(t, {
    'README.md': `\`\`\`sh\n${argv.join(' ')}\n\`\`\`\n`,
    'leak.mjs': leakScript,
    [CONFIG_FILE]: JSON.stringify({ commands: { leak: declare(argv) } }),
  });
  const checked = spawnSync(node, [bin, 'check'], { cwd: checkRoot, encoding: 'utf8', env });
  const output = `${checked.stdout}${checked.stderr}`;
  assert.equal(checked.status, 1, output);
  for (const token of prefixedShapes) assert.equal(output.includes(token), false, `${token}\n${output}`);
  assert.ok(output.includes(`line 2: command mismatch (command "leak" exited with status 1: ${redactedLines.join('\n')})`), output);
  assert.ok(output.includes('The README is not fully verified: 0 of 1 claim unverifiable, 1 mismatched, 0 verified.'), output);

  const begin = '# demo\n\n<!-- freshreadme:begin out -->\n';
  const end = '<!-- freshreadme:end out -->\n';
  const regenRoot = makeRepo(t, {
    'README.md': `${begin}${end}`,
    'leak.mjs': leakScript,
    [CONFIG_FILE]: JSON.stringify({ commands: { leak: declare([node, 'leak.mjs', '0']) }, regions: { out: { command: 'leak' } } }),
  });
  const regenerated = spawnSync(node, [bin, 'regen', '--write'], { cwd: regenRoot, encoding: 'utf8', env });
  assert.equal(regenerated.status, 0, `${regenerated.stdout}${regenerated.stderr}`);
  const written = readFileSync(path.join(regenRoot, 'README.md'), 'utf8');
  for (const token of prefixedShapes) assert.equal(written.includes(token), false, `${token}\n${written}`);
  assert.equal(written, `${begin}${redactedLines.join('\n')}\n${end}`);
});

test('redact leaves ordinary prose and short look-alikes unchanged', () => {
  const unchanged = [
    'the ASIA region',
    'AKIA in prose',
    'npm_install is a word',
    'sk_live_short',
    'rk_test_' + 'x'.repeat(8),
    'glpat-abc',
    'AIza short',
    'Set the region to us-east-1 and run npm install.',
  ];
  for (const text of unchanged) {
    assert.equal(redact(text), text, text);
  }
});

test('regen --write does not write a temporary AWS key into the README', (t) => {
  const repoRoot = makeRepo(t, {
    'README.md': '# demo\n\n<!-- freshreadme:begin out -->\n<!-- freshreadme:end out -->\n',
    'print.mjs': 'console.log(process.argv[2]);\n',
    [CONFIG_FILE]: JSON.stringify({ commands: { print: declare([node, 'print.mjs', asiaKey]) }, regions: { out: { command: 'print' } } }),
  });
  const result = regen({ repoRoot, write: true });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  const written = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(written.includes('[redacted]'), written);
  assert.equal(written.includes(asiaKey), false, written);
});

test('a declared command that exits 3 is a mismatch, not a refusal', (t) => {
  const { repoRoot, config } = withCommands(t, { fails: declare([node, 'fails.mjs']) }, { 'fails.mjs': 'process.exit(3);\n' });
  const result = runDeclared(config, 'fails', { repoRoot });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, 'nonzero');
  assert.equal(result.status, 3);
});

test('a command that times out or cannot start is a spawn error', (t) => {
  const { repoRoot, config } = withCommands(t, {
    slow: declare([node, 'slow.mjs'], { timeoutMs: 200 }),
    missing: declare(['freshreadme-no-such-program']),
  }, { 'slow.mjs': 'setTimeout(() => {}, 10000);\n' });
  for (const id of ['slow', 'missing']) {
    const result = runDeclared(config, id, { repoRoot });
    assert.equal(result.reason, 'spawn-error', result.message);
    assert.equal(result.exitCode, 2);
    assert.equal(result.status, null);
  }
});

test('a timed-out command that ignores SIGTERM is still killed', (t) => {
  const { repoRoot, config } = withCommands(t, { stubborn: declare([node, 'stubborn.mjs'], { timeoutMs: 300 }) }, {
    'stubborn.mjs': "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
  });
  const started = Date.now();
  const result = runDeclared(config, 'stubborn', { repoRoot });
  const elapsed = Date.now() - started;
  assert.equal(result.reason, 'spawn-error', result.message);
  assert.equal(result.exitCode, 2);
  assert.ok(result.message.includes('timed out'), result.message);
  assert.ok(elapsed < 10000, `took ${elapsed}ms`);
});
