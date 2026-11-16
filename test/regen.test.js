import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  fstatSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check } from '../src/check.js';
import { regen } from '../src/regen.js';
import { parseRegions } from '../src/regions.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/regen/${name}`, import.meta.url), 'utf8');
const baseConfig = () => JSON.parse(fixture('config.json'));

const SCRIPTS = {
  'usage.mjs': "process.stdout.write('usage: tool [options]\\n\\n  --help  show help\\n\\n\\n');\n",
  'version.mjs': "process.stdout.write('1.2.3');\n",
  'bare-cr.mjs': "process.stdout.write('1.2.3\\r');\n",
  'fail.mjs': "process.stderr.write('broken');\nprocess.exit(1);\n",
  'end-marker.mjs': "process.stdout.write('before\\n<!-- freshreadme:end usage -->\\nafter\\n');\n",
  'begin-marker.mjs': "process.stdout.write('before\\n<!-- freshreadme:begin usage -->\\nafter\\n');\n",
};

const populate = (root, editConfig) => {
  const config = editConfig(baseConfig());
  for (const command of Object.values(config.commands)) command.argv[0] = process.execPath;
  writeFileSync(path.join(root, '.freshreadme.json'), JSON.stringify(config));
  for (const [name, source] of Object.entries(SCRIPTS)) writeFileSync(path.join(root, name), source);
};

const withRepo = (t, readme, editConfig = (config) => config) => {
  const root = mkdtempSync(path.join(tmpdir(), 'freshreadme-regen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  populate(root, editConfig);
  writeFileSync(path.join(root, 'README.md'), readme);
  const readmeBytes = () => readFileSync(path.join(root, 'README.md'));
  return { root, readmeBytes };
};

// Line endings are fixed here rather than trusted to the checkout, which may rewrite them.
const crlfReadme = () => fixture('crlf.md').replace(/\r?\n/g, '\r\n');
const noFinalNewlineReadme = () => fixture('no-final-newline.md').replace(/\r?\n$/, '');

// The text with every region's inner lines removed: markers and everything else kept.
const outside = (text) =>
  text.replace(/(<!--\s*freshreadme:begin\s+(\S+?)\s*-->\r?\n)[\s\S]*?(<!--\s*freshreadme:end\s+\2\s*-->)/g, '$1$3');

for (const name of ['unclosed.md', 'nested.md', 'duplicated-id.md', 'unknown-id.md', 'end-without-begin.md']) {
  test(`malformed markers in ${name} exit 2 and leave the README unchanged`, (t) => {
    const { root, readmeBytes } = withRepo(t, fixture(name));
    const before = readmeBytes();
    for (const write of [false, true]) {
      const result = regen({ repoRoot: root, write });
      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.changed, []);
      assert.ok(result.errors.length > 0);
      assert.ok(readmeBytes().equals(before));
    }
  });
}

for (const [label, makeReadme] of [
  ['CRLF', crlfReadme],
  ['no final newline', noFinalNewlineReadme],
]) {
  test(`write twice on a ${label} README changes nothing the second time and keeps bytes outside regions`, (t) => {
    const original = makeReadme();
    const { root, readmeBytes } = withRepo(t, original);

    const first = regen({ repoRoot: root, write: true });
    assert.equal(first.exitCode, 0, first.errors.join('\n'));
    assert.deepEqual(first.changed, ['usage', 'version']);
    const afterFirst = readmeBytes();
    const text = afterFirst.toString('utf8');
    assert.notEqual(text, original);
    assert.equal(outside(text), outside(original));
    assert.match(text, /usage: tool \[options\]/);
    assert.match(text, /1\.2\.3/);

    const second = regen({ repoRoot: root, write: true });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.changed, []);
    assert.ok(readmeBytes().equals(afterFirst));

    assert.equal(regen({ repoRoot: root }).exitCode, 0);
  });
}

test('regenerated content uses the file line ending and one trailing newline', (t) => {
  const { root, readmeBytes } = withRepo(t, crlfReadme());
  regen({ repoRoot: root, write: true });
  const text = readmeBytes().toString('utf8');
  assert.doesNotMatch(text, /(^|[^\r])\n/);
  assert.ok(
    text.includes(
      '<!-- freshreadme:begin usage -->\r\nusage: tool [options]\r\n\r\n  --help  show help\r\n<!-- freshreadme:end usage -->\r\n',
    ),
  );
  assert.ok(text.includes('<!--  freshreadme:begin version  -->\r\n1.2.3\r\n<!--  freshreadme:end version  -->\r\n'));
});

for (const [label, readme] of [
  ['an LF', '# T\n<!-- freshreadme:begin version -->\nold\n<!-- freshreadme:end version -->\n'],
  ['a CRLF', '# T\r\n<!-- freshreadme:begin version -->\r\nold\r\n<!-- freshreadme:end version -->\r\n'],
]) {
  test(`output ending in a bare CR keeps ${label} README's line ending, checks up to date and rewrites nothing twice`, (t) => {
    const { root, readmeBytes } = withRepo(t, readme, (config) => {
      config.commands.version.argv = ['node', 'bare-cr.mjs'];
      return config;
    });
    const first = regen({ repoRoot: root, write: true });
    assert.equal(first.exitCode, 0, first.errors.join('\n'));
    assert.deepEqual(first.changed, ['version']);
    const afterFirst = readmeBytes();
    assert.equal(afterFirst.toString('utf8'), readme.replace('old', '1.2.3'));
    assert.equal(outside(afterFirst.toString('utf8')), outside(readme));

    const checked = check({ repoRoot: root });
    assert.equal(checked.exitCode, 0, checked.errors.join('\n'));
    assert.ok(checked.claims.some((claim) => claim.class === 'region' && claim.status === 'verified'));

    const second = regen({ repoRoot: root, write: true });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.changed, []);
    assert.ok(readmeBytes().equals(afterFirst));
  });
}

test(
  'the temp file of a 0600 README is never broader than 0600 before its content is written',
  { skip: process.platform === 'win32' && 'Windows has no POSIX file modes or umask' },
  (t) => {
    const { root } = withRepo(t, noFinalNewlineReadme());
    const readme = path.join(root, 'README.md');
    chmodSync(readme, 0o600);
    const previous = process.umask(0o022);
    t.after(() => process.umask(previous));
    const observed = [];
    const fs = {
      writeFileSync: (target, data, ...rest) => {
        if (typeof target === 'number') {
          // An already-created temp file: its mode as it stands before any content.
          observed.push(fstatSync(target).mode & 0o777);
          return writeFileSync(target, data, ...rest);
        }
        // A path: this one call creates the file and fills it, so the content exists at this mode.
        writeFileSync(target, data, ...rest);
        observed.push(statSync(target).mode & 0o777);
        return undefined;
      },
    };
    const result = regen({ repoRoot: root, write: true, fs });
    assert.equal(result.exitCode, 0, result.errors.join('\n'));
    assert.equal(observed.length, 1);
    assert.equal(observed[0] & ~0o600, 0, `temp file mode was ${observed[0].toString(8)}`);
    assert.equal(statSync(readme).mode & 0o777, 0o600);
  },
);

test('a README without a final newline keeps it absent', (t) => {
  const { root, readmeBytes } = withRepo(t, noFinalNewlineReadme());
  regen({ repoRoot: root, write: true });
  const text = readmeBytes().toString('utf8');
  assert.ok(text.endsWith('<!-- freshreadme:begin version -->\n1.2.3\n<!-- freshreadme:end version -->'));
});

test('without write, out-of-date regions exit 1 and nothing is written', (t) => {
  const { root, readmeBytes } = withRepo(t, crlfReadme());
  const before = readmeBytes();
  const result = regen({ repoRoot: root });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.changed, ['usage', 'version']);
  assert.match(result.output, /region "usage" is out of date/);
  assert.ok(readmeBytes().equals(before));
});

test('a failing region command exits 2 and leaves the README unchanged', (t) => {
  const { root, readmeBytes } = withRepo(t, crlfReadme(), (config) => {
    config.commands.version.argv = ['node', 'fail.mjs'];
    return config;
  });
  const before = readmeBytes();
  const result = regen({ repoRoot: root, write: true });
  assert.equal(result.exitCode, 2);
  assert.match(result.errors.join('\n'), /region "version": command "version" exited with status 1/);
  assert.ok(readmeBytes().equals(before));
});

for (const [region, script] of [
  ['usage', 'end-marker.mjs'],
  ['version', 'begin-marker.mjs'],
]) {
  test(`output of region "${region}" containing a marker line (${script}) exits 2 and leaves the README unchanged`, (t) => {
    const { root, readmeBytes } = withRepo(t, crlfReadme(), (config) => {
      config.commands[region].argv = ['node', script];
      return config;
    });
    const before = readmeBytes();
    for (const write of [false, true]) {
      const result = regen({ repoRoot: root, write });
      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.changed, []);
      assert.match(result.errors.join('\n'), new RegExp(`region "${region}": command output contains a freshreadme marker line`));
      assert.ok(readmeBytes().equals(before));
    }
  });
}

for (const [label, fs] of [
  [
    'a temp write that fails half-way',
    {
      writeFileSync: (target, data) => {
        const bytes = Buffer.from(data);
        writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw new Error('ENOSPC: simulated');
      },
    },
  ],
  [
    'a failing rename',
    {
      renameSync: () => {
        throw new Error('ENOSPC: simulated');
      },
    },
  ],
]) {
  test(`${label} exits 2, leaves the README unchanged and leaves no temp file`, (t) => {
    const { root, readmeBytes } = withRepo(t, crlfReadme());
    const before = readmeBytes();
    const entries = readdirSync(root).sort();
    const result = regen({ repoRoot: root, write: true, fs });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.changed, []);
    assert.equal(result.output, '');
    assert.deepEqual(result.errors, ['README.md: could not write: ENOSPC: simulated']);
    assert.ok(readmeBytes().equals(before));
    assert.deepEqual(readdirSync(root).sort(), entries);
  });
}

test('a normal write replaces the README, keeps its mode and leaves no temp file', (t) => {
  const { root, readmeBytes } = withRepo(t, noFinalNewlineReadme());
  const readme = path.join(root, 'README.md');
  chmodSync(readme, 0o640);
  const entries = readdirSync(root).sort();
  const result = regen({ repoRoot: root, write: true });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(result.changed, ['usage', 'version']);
  const text = readmeBytes().toString('utf8');
  assert.ok(text.endsWith('<!-- freshreadme:begin version -->\n1.2.3\n<!-- freshreadme:end version -->'));
  assert.match(text, /usage: tool \[options\]\n\n {2}--help {2}show help\n<!--/);
  assert.equal(statSync(readme).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(root).sort(), entries);
});

test('an invalid config exits 2 and leaves the README unchanged', (t) => {
  const { root, readmeBytes } = withRepo(t, crlfReadme());
  writeFileSync(path.join(root, '.freshreadme.json'), '{ not json');
  const before = readmeBytes();
  assert.equal(regen({ repoRoot: root, write: true }).exitCode, 2);
  assert.ok(readmeBytes().equals(before));
});

// A temp parent holding repo/, parent/outside.md and parent/repo-evil/README.md, with README links in repo/.
const withLinkedRepo = (t, links, editConfig = (config) => config) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'freshreadme-link-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo');
  const evil = path.join(parent, 'repo-evil');
  mkdirSync(root);
  mkdirSync(evil);
  populate(root, editConfig);
  const outsideFiles = [path.join(parent, 'outside.md'), path.join(evil, 'README.md')];
  for (const file of outsideFiles) writeFileSync(file, crlfReadme());
  for (const [name, target] of Object.entries(links)) symlinkSync(target, path.join(root, name));
  const state = () => ({
    bytes: outsideFiles.map((file) => readFileSync(file)),
    entries: [root, parent, evil].map((dir) => readdirSync(dir).sort()),
  });
  return { root, state };
};

const countingSpawn = () => {
  const calls = [];
  return { calls, spawn: (...args) => (calls.push(args), spawnSync(...args)) };
};

for (const [label, links] of [
  ['a link to a file outside the repository', { 'README.md': '../outside.md' }],
  ['a two-hop link chain ending outside', { 'README.md': 'hop.md', 'hop.md': '../outside.md' }],
  ['a link into a sibling directory whose name starts with the repository name', { 'README.md': '../repo-evil/README.md' }],
  ['a broken link', { 'README.md': '../missing.md' }],
]) {
  test(`regen --write refuses ${label}, runs nothing and writes nothing`, (t) => {
    const { root, state } = withLinkedRepo(t, links);
    const before = state();
    const { calls, spawn } = countingSpawn();
    const result = regen({ repoRoot: root, write: true, spawn });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.changed, []);
    assert.equal(result.output, '');
    assert.deepEqual(result.errors, ['README.md: resolves outside the repository']);
    assert.equal(calls.length, 0);
    assert.deepEqual(state(), before);
  });
}

test('a README linked to a file inside the repository is regenerated and stays a link', (t) => {
  const { root, state } = withLinkedRepo(t, {});
  mkdirSync(path.join(root, 'docs'));
  const real = path.join(root, 'docs', 'real.md');
  writeFileSync(real, crlfReadme());
  symlinkSync('docs/real.md', path.join(root, 'README.md'));
  const before = state();
  const docsEntries = readdirSync(path.join(root, 'docs'));
  const result = regen({ repoRoot: root, write: true });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(result.changed, ['usage', 'version']);
  assert.match(readFileSync(real, 'utf8'), /usage: tool \[options\]/);
  assert.ok(lstatSync(path.join(root, 'README.md')).isSymbolicLink());
  assert.equal(readlinkSync(path.join(root, 'README.md')), 'docs/real.md');
  assert.deepEqual(readdirSync(path.join(root, 'docs')), docsEntries);
  assert.deepEqual(state(), before);
});

test('a command that retargets README.md outside the repository during the run exits 2 and writes nothing', (t) => {
  // The new link keeps the old one's length and mtime. Either the runner's effects guard or regen's
  // publish-time recheck may refuse first, so only the outcome is asserted.
  const inside = 'inner-file.md';
  const { root, state }= withLinkedRepo(t, { 'README.md': inside }, (config) => {
    config.commands.version.argv = ['node', 'retarget.mjs'];
    return config;
  });
  writeFileSync(
    path.join(root, 'retarget.mjs'),
    [
      "import { lstatSync, lutimesSync, symlinkSync, unlinkSync } from 'node:fs';",
      "const { atime, mtime } = lstatSync('README.md');",
      "unlinkSync('README.md');",
      "symlinkSync('../outside.md', 'README.md');",
      "lutimesSync('README.md', atime, mtime);",
      "process.stdout.write('1.2.3');",
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(root, inside), crlfReadme());
  lutimesSync(path.join(root, 'README.md'), 1_000_000_000, 1_000_000_000);
  const before = state();
  const result = regen({ repoRoot: root, write: true });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.changed, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /README\.md/);
  // Outside file bytes and the entries of repo/ and its parent, so no temp file in either directory.
  assert.deepEqual(state(), before);
});

test('the publish-time recheck refuses a README that resolves outside the repository by then', (t) => {
  const { root, state } = withLinkedRepo(t, {});
  const readme = path.join(root, 'README.md');
  writeFileSync(readme, crlfReadme());
  const outsideFile = path.join(path.dirname(root), 'outside.md');
  let readmeResolutions = 0;
  const writes = [];
  const fs = {
    realpathSync: (target, ...rest) => {
      if (String(target) !== readme) return realpathSync(target, ...rest);
      readmeResolutions += 1;
      return realpathSync(readmeResolutions === 1 ? readme : outsideFile);
    },
    writeFileSync: (...args) => (writes.push(['writeFileSync', args[0]]), writeFileSync(...args)),
    renameSync: (...args) => (writes.push(['renameSync', args[0]]), renameSync(...args)),
  };
  const before = state();
  const result = regen({ repoRoot: root, write: true, fs });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.errors, ['README.md: resolves outside the repository']);
  assert.deepEqual(writes, []);
  assert.deepEqual(state(), before);
});

test('parseRegions reports 1-based lines and content for LF, CRLF and no final newline', () => {
  const config = baseConfig();
  const lf = '# T\n<!-- freshreadme:begin usage -->\na\nb\n<!-- freshreadme:end usage -->';
  const expected = [{ id: 'usage', beginLine: 2, endLine: 5, content: 'a\nb\n' }];
  assert.deepEqual(parseRegions(lf, config), { ok: true, regions: expected });
  assert.deepEqual(parseRegions(`${lf}\n`, config), { ok: true, regions: expected });
  assert.deepEqual(parseRegions(`${lf.replace(/\n/g, '\r\n')}\r\n`, config), { ok: true, regions: expected });
});

test('parseRegions refuses each kind of malformed marker', () => {
  const config = baseConfig();
  const cases = {
    'unclosed.md': /never closed/,
    'nested.md': /cannot nest/,
    'duplicated-id.md': /more than once/,
    'unknown-id.md': /not declared/,
    'end-without-begin.md': /no matching begin/,
  };
  for (const [name, pattern] of Object.entries(cases)) {
    const result = parseRegions(fixture(name), config);
    assert.equal(result.ok, false, name);
    assert.equal(result.exitCode, 2);
    assert.match(result.errors.join('\n'), pattern, name);
  }
});
