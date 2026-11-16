import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/check.js';
import { EFFECTS_NOTE } from '../src/runner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'freshreadme.js');
const TOKEN = `ghp_${'A'.repeat(36)}`;
const J = 'unverifiable: judgement';
const FORGED = '\n::warning::forged\n::add-mask::x\n';

const fixture = (name) => readFileSync(new URL(`./fixtures/cli/${name}`, import.meta.url), 'utf8');
const lines = (...rows) => `${rows.join('\n')}\n`.replaceAll('{node}', process.execPath);

const FILES = {
  'ok.mjs': "process.stdout.write('ok\\n');\n",
  'fail.mjs': `process.stderr.write(${JSON.stringify(`broken ${TOKEN}`)});\nprocess.exit(1);\n`,
  'forge.mjs':
    `process.stdout.write(${JSON.stringify(`out${FORGED}`)});\n` +
    `process.stderr.write(${JSON.stringify(`err${FORGED}`)});\nprocess.exit(1);\n`,
  'package.json': '{ "version": "1.2.3" }\n',
};

const CONFIG = JSON.stringify({
  commands: {
    ok: { argv: [process.execPath, 'ok.mjs'], effects: 'none' },
    fail: { argv: [process.execPath, 'fail.mjs'], effects: 'none' },
    forge: { argv: [process.execPath, 'forge.mjs'], effects: 'none' },
  },
  regions: { out: { command: 'ok' } },
  facts: [{ id: 'version', text: 'version 1.2.3', file: 'package.json', json: 'version', equals: '1.2.3' }],
});

const withRepo = (t, readme, files = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'freshreadme-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ '.freshreadme.json': CONFIG, ...FILES, ...files })) {
    writeFileSync(path.join(root, name), source);
  }
  writeFileSync(path.join(root, 'README.md'), readme);
  return root;
};

// The CLI under test, without whatever GITHUB_ACTIONS value the surrounding environment has.
const run = (cwd, args, env = {}) => {
  const { GITHUB_ACTIONS, ...rest } = process.env;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...rest, ...env } });
};

const OK_README = lines('# Demo', '', 'Some prose nobody can verify.', '', '```sh', '{node} ok.mjs', '```', '', 'version 1.2.3');
const MISMATCH_README = lines('# Demo', '', '```sh', '{node} fail.mjs', '```', '', 'version 1.2.3');
const MISMATCH_FILES = { 'package.json': '{ "version": "2.0.0" }\n' };
const ANNOTATIONS = [
  `::error file=README.md,line=4::command "fail" exited with status 1: broken [redacted]`,
  `::error file=README.md,line=7::package.json version is "2.0.0", expected "1.2.3"`,
];
const annotations = (stdout) => stdout.split('\n').filter((line) => line.startsWith('::error'));
const NOTE_LINE = `note: ${EFFECTS_NOTE}`;
const endsWithNote = (stream, prefix = '') => assert.equal(stream.split('\n').at(-2), `${prefix}${NOTE_LINE}`, stream);

test('check exits 0 when nothing mismatches, even with unverifiable prose', (t) => {
  const result = run(withRepo(t, OK_README), ['check']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^line 3: prose unverifiable: judgement/m);
  assert.match(result.stdout, /^line 6: command verified/m);
  assert.match(result.stdout, /^line 9: fact verified/m);
  assert.match(result.stdout, /not fully verified: 2 of 4 claims unverifiable/);
  endsWithNote(result.stdout);
});

test('--format github prints each mismatch as an ::error line with its README line and exits 1', (t) => {
  const result = run(withRepo(t, MISMATCH_README, MISMATCH_FILES), ['check', '--format', 'github']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(annotations(result.stdout), ANNOTATIONS);
  assert.ok(!result.stdout.includes(TOKEN));
  endsWithNote(result.stdout);
  assert.ok(!NOTE_LINE.startsWith('::'));
});

test('GITHUB_ACTIONS=true selects the github format unless another format is asked for', (t) => {
  const root = withRepo(t, MISMATCH_README, MISMATCH_FILES);
  const auto = run(root, ['check'], { GITHUB_ACTIONS: 'true' });
  assert.equal(auto.status, 1);
  assert.deepEqual(annotations(auto.stdout), ANNOTATIONS);

  const text = run(root, ['check', '--format=text'], { GITHUB_ACTIONS: 'true' });
  assert.equal(text.status, 1);
  assert.deepEqual(annotations(text.stdout), []);
  assert.match(text.stdout, /^\| line 4: command mismatch/m);

  const plain = run(root, ['check']);
  assert.deepEqual(annotations(plain.stdout), []);
});

test('child output cannot inject workflow commands under the github format', (t) => {
  const root = withRepo(t, lines('# Demo', '', '```sh', '{node} forge.mjs', '```'));
  const expected = [
    '::error file=README.md,line=4::command "forge" exited with status 1: err%0A::warning::forged%0A::add-mask::x',
    `::notice file=README.md,line=1::prose ${J} (needs human judgement)`,
  ];
  for (const [args, env] of [[['check', '--format', 'github'], {}], [['check'], { GITHUB_ACTIONS: 'true' }]]) {
    const result = run(root, args, env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('::')), expected);
    assert.ok(result.stdout.includes('%0A::warning::forged%0A::add-mask::x'));
    assert.equal(result.stdout.split('::warning::forged').length, result.stdout.split('%0A::warning::forged').length);
    assert.equal(result.stdout.split('::add-mask::x').length, result.stdout.split('%0A::add-mask::x').length);
  }
});

const INJECTED = ['::add-mask::sentinel', '::error::forged', '##[add-mask]legacy'];
const PAYLOAD = `oops${['\n', '\r\n', '\r'].flatMap((sep) => INJECTED.flatMap((cmd) => [`${sep}${cmd}`, `${sep}   ${cmd}`])).join('')}`;
const INJECT_FILES = {
  'inject-fail.mjs': `process.stdout.write(${JSON.stringify(PAYLOAD)});\nprocess.stderr.write(${JSON.stringify(PAYLOAD)});\nprocess.exit(1);\n`,
  'inject-ok.mjs': `process.stdout.write(${JSON.stringify(PAYLOAD)});\n`,
};
const injectConfig = (regions) =>
  JSON.stringify({
    commands: {
      injectFail: { argv: [process.execPath, 'inject-fail.mjs'], effects: 'none' },
      injectOk: { argv: [process.execPath, 'inject-ok.mjs'], effects: 'none' },
    },
    regions,
  });
const runnerLines = (stream) => stream.split(/\r\n|\r|\n/);

// A local harness mirroring the two parse rules in the GitHub runner source (actions/runner ActionCommand);
// it is not an Actions run. The runner trims with .NET char.IsWhiteSpace, which, unlike JavaScript's
// trimStart, also removes U+0085, so the set is written out: JavaScript \s plus U+0085.
// Legacy: ##[ anywhere in the line with a later ]. v2: the trimmed line starts with :: and contains a second ::.
const RUNNER_LEADING_WHITESPACE = /^[\s\u0085]+/;
const isLegacyCommand = (line) => {
  const start = line.indexOf('##[');
  return start >= 0 && line.indexOf(']', start + 3) > start;
};
const isV2Command = (line) => {
  const trimmed = line.replace(RUNNER_LEADING_WHITESPACE, '');
  return trimmed.startsWith('::') && trimmed.indexOf('::', 2) >= 0;
};
const commandLines = (stream) => runnerLines(stream).filter((line) => isLegacyCommand(line) || isV2Command(line));
const assertNoCommands = (stream) => assert.deepEqual(commandLines(stream), [], stream);
const assertPrefixed = (stream) => {
  for (const line of runnerLines(stream)) assert.ok(line === '' || line.startsWith('| '), JSON.stringify(line));
};
// The Actions form of plain LF-only output with no ##[: every line prefixed, the trailing LF kept.
const prefixed = (stream) => `${stream.slice(0, -1).split('\n').map((line) => `| ${line}`).join('\n')}\n`;

test('child output cannot start a workflow command in text or regen output under GITHUB_ACTIONS=true', (t) => {
  const GA = { GITHUB_ACTIONS: 'true' };
  const region = (command) =>
    withRepo(t, lines('# Demo', '', '<!-- freshreadme:begin out -->', 'stale', '<!-- freshreadme:end out -->'), {
      ...INJECT_FILES,
      '.freshreadme.json': injectConfig({ out: { command } }),
    });

  // (a) regen with a failing command: the error, carrying child stderr, goes to stderr.
  const failRoot = region('injectFail');
  const failed = run(failRoot, ['regen'], GA);
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /^\| error: region "out": command "injectFail" exited with status 1: oops/);
  assertNoCommands(failed.stderr);
  endsWithNote(failed.stderr, '| ');
  const failedPlain = run(failRoot, ['regen']);
  assert.equal(failedPlain.status, 2);
  assert.ok(failedPlain.stderr.includes(PAYLOAD), failedPlain.stderr);

  // (b) regen with a succeeding command whose region is out of date: the report goes to stdout.
  const okRoot = region('injectOk');
  const stale = run(okRoot, ['regen'], GA);
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /README\.md: region "out" is out of date/);
  assertNoCommands(stale.stdout);
  assertNoCommands(stale.stderr);
  assert.equal(stale.stdout, prefixed(run(okRoot, ['regen']).stdout));

  // (c) check --format text with a failing command.
  const checkRoot = withRepo(t, lines('# Demo', '', '```sh', '{node} inject-fail.mjs', '```'), {
    ...INJECT_FILES,
    '.freshreadme.json': injectConfig({}),
  });
  const text = run(checkRoot, ['check', '--format', 'text'], GA);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.match(text.stdout, /^\| line 4: command mismatch \(command "injectFail" exited with status 1: oops/m);
  assertNoCommands(text.stdout);
  assertNoCommands(text.stderr);
  endsWithNote(text.stdout, '| ');
  const textPlain = run(checkRoot, ['check', '--format', 'text']);
  assert.equal(textPlain.status, 1);
  assert.ok(textPlain.stdout.includes(PAYLOAD), textPlain.stdout);

  // The github format and --json are untouched: only FreshReadme's own escaped annotation starts with ::.
  const github = run(checkRoot, ['check'], GA);
  assert.equal(github.status, 1);
  assert.equal(github.stdout, run(checkRoot, ['check', '--format', 'github']).stdout);
  const own = commandLines(github.stdout);
  assert.equal(own.length, 2, github.stdout);
  assert.ok(own[0].startsWith('::error file=README.md,line=4::command "injectFail" exited with status 1: oops%0A::add-mask::sentinel'));
  assert.ok(own[0].includes('%0D%0A   ##[add-mask]legacy%0D::add-mask::sentinel'));
  assert.equal(own[1], `::notice file=README.md,line=1::prose ${J} (needs human judgement)`);

  const json = run(checkRoot, ['check', '--json'], GA);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(run(checkRoot, ['check', '--json']).stdout));
  assert.ok(JSON.parse(json.stdout).claims.some((claim) => claim.detail.includes(PAYLOAD)));
});

const LEGACY = '##[error]x';
const LEGACY_PAYLOAD = `oops ${LEGACY} mid${['\n', '\r\n', '\r']
  .flatMap((sep) => [LEGACY, `| ${LEGACY}`, `text ${LEGACY}`, '::add-mask::sentinel', '::error::forged'].map((cmd) => `${sep}${cmd}`))
  .join('')}`;

test('child output cannot form a legacy or v2 workflow command anywhere in a line under GITHUB_ACTIONS=true', (t) => {
  const GA = { GITHUB_ACTIONS: 'true' };
  const repo = (readme, regions) =>
    withRepo(t, readme, {
      'legacy-fail.mjs': `process.stdout.write(${JSON.stringify(LEGACY_PAYLOAD)});\nprocess.stderr.write(${JSON.stringify(LEGACY_PAYLOAD)});\nprocess.exit(1);\n`,
      '.freshreadme.json': JSON.stringify({
        commands: { legacyFail: { argv: [process.execPath, 'legacy-fail.mjs'], effects: 'none' } },
        regions,
      }),
    });
  const checkRoot = repo(lines('# Demo', '', '```sh', '{node} legacy-fail.mjs', '```'), {});
  const regenRoot = repo(lines('# Demo', '', '<!-- freshreadme:begin out -->', 'stale', '<!-- freshreadme:end out -->'), {
    out: { command: 'legacyFail' },
  });

  for (const [root, args, status] of [
    [checkRoot, ['check', '--format', 'text'], 1],
    [checkRoot, ['check', '--json'], 1],
    [regenRoot, ['regen'], 2],
  ]) {
    const result = run(root, args, GA);
    assert.equal(result.status, status, args.join(' ') + result.stdout + result.stderr);
    assert.equal(run(root, args).status, status, args.join(' '));
    assert.deepEqual(commandLines(result.stdout), [], args.join(' '));
    assert.deepEqual(commandLines(result.stderr), [], args.join(' '));
  }

  const json = run(checkRoot, ['check', '--json'], GA);
  assert.ok(JSON.parse(json.stdout).claims.some((claim) => claim.detail.includes(LEGACY_PAYLOAD)), json.stdout);

  // FreshReadme's own annotations still parse as v2 commands.
  const github = run(checkRoot, ['check'], GA);
  assert.equal(github.status, 1);
  const own = runnerLines(github.stdout).filter((line) => line.startsWith('::error file='));
  assert.equal(own.length, 1, github.stdout);
  assert.ok(own.every(isV2Command), github.stdout);
});

test('an undeclared README command is a ::notice annotation under the github format', (t) => {
  const root = withRepo(t, lines('# Demo', '', '```sh', 'npm install', '```'), {
    '.freshreadme.json': JSON.stringify({ commands: {} }),
  });
  const textStatus = run(root, ['check', '--format', 'text']).status;
  for (const [args, env] of [[['check', '--format', 'github'], {}], [['check'], { GITHUB_ACTIONS: 'true' }]]) {
    const label = args.join(' ');
    const result = run(root, args, env);
    assert.equal(result.status, textStatus, label + result.stdout + result.stderr);
    const notices = result.stdout.split('\n').filter((line) => line.startsWith('::notice file=README.md,line=4::'));
    assert.equal(notices.length, 1, result.stdout);
    assert.ok(notices[0].startsWith('::notice file=README.md,line=4::command unverifiable: not-allowlisted ('), result.stdout);
    assert.deepEqual(
      commandLines(result.stdout).filter((line) => !/^::(?:error|notice)[ :]/.test(line)),
      [],
      result.stdout,
    );
    assert.deepEqual(commandLines(result.stderr), [], label);
  }
});

// Whitespace the runner trims but JavaScript's trimStart keeps (U+0085) or also trims, before a command.
const WHITESPACE = ['\u0085', ' ', ' ', '　', ' '];
const WS_PAYLOAD = `oops text ${LEGACY} mid${['\n', '\r\n', '\r']
  .flatMap((sep) => WHITESPACE.flatMap((ws) => ['::stop-commands::mute', '::error::x'].map((cmd) => `${sep}${ws}${cmd}`)))
  .join('')}`;

test('no line of text or regen output is a workflow command after runner whitespace trimming under GITHUB_ACTIONS=true', (t) => {
  const GA = { GITHUB_ACTIONS: 'true' };
  const repo = (readme, regions) =>
    withRepo(t, readme, {
      'ws-fail.mjs': `process.stdout.write(${JSON.stringify(WS_PAYLOAD)});\nprocess.stderr.write(${JSON.stringify(WS_PAYLOAD)});\nprocess.exit(1);\n`,
      'ws-ok.mjs': `process.stdout.write(${JSON.stringify(WS_PAYLOAD)});\n`,
      '.freshreadme.json': JSON.stringify({
        commands: {
          wsFail: { argv: [process.execPath, 'ws-fail.mjs'], effects: 'none' },
          wsOk: { argv: [process.execPath, 'ws-ok.mjs'], effects: 'none' },
        },
        regions,
      }),
    });
  const regionReadme = lines('# Demo', '', '<!-- freshreadme:begin out -->', 'stale', '<!-- freshreadme:end out -->');
  const checkRoot = repo(lines('# Demo', '', '```sh', '{node} ws-fail.mjs', '```'), {});
  const failRoot = repo(regionReadme, { out: { command: 'wsFail' } });
  const staleRoot = repo(regionReadme, { out: { command: 'wsOk' } });

  for (const [root, args, status, stream] of [
    [checkRoot, ['check', '--format', 'text'], 1, 'stdout'],
    [failRoot, ['regen'], 2, 'stderr'],
    [staleRoot, ['regen'], 1, 'stdout'],
  ]) {
    const label = `${args.join(' ')} ${stream}`;
    const result = run(root, args, GA);
    assert.equal(result.status, status, label + result.stdout + result.stderr);
    assert.equal(run(root, args).status, status, label);
    assert.notEqual(result[stream], '', label);
    for (const output of [result.stdout, result.stderr]) {
      assert.deepEqual(commandLines(output), [], label);
      assertPrefixed(output);
    }
  }

  // Without Actions the child output reaches the text unchanged, so the cases above carry it.
  assert.ok(run(checkRoot, ['check', '--format', 'text']).stdout.includes(WS_PAYLOAD));
  assert.ok(run(failRoot, ['regen']).stderr.includes(WS_PAYLOAD));
});

test('--json prints the claims, fullyVerified and summary', (t) => {
  const result = run(withRepo(t, MISMATCH_README, MISMATCH_FILES), ['check', '--json'], { GITHUB_ACTIONS: 'true' });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.fullyVerified, false);
  assert.deepEqual(parsed.summary, { total: 3, verified: 0, mismatch: 2, unverifiable: 1 });
  assert.deepEqual(
    parsed.claims.map(({ line, status }) => [line, status]),
    [[1, J], [4, 'mismatch'], [7, 'mismatch']],
  );
  assert.equal(parsed.effectsNote, EFFECTS_NOTE);
});

const KEY_BEGIN = `-----BEGIN ${'RSA PRIVATE KEY'}-----`;
const KEY_END = `-----END ${'RSA PRIVATE KEY'}-----`;
const failWith = (text) => `process.stderr.write(${JSON.stringify(text)});\nprocess.exit(1);\n`;

test('a key delimiter in one claim and its closing delimiter in a later one do not erase the claims between', (t) => {
  const root = withRepo(t, lines('# Demo', '', '```sh', '{node} begin.mjs', '{node} silent.mjs', '{node} end.mjs', '```'), {
    'begin.mjs': failWith(KEY_BEGIN),
    'silent.mjs': 'process.exit(1);\n',
    'end.mjs': failWith(KEY_END),
    '.freshreadme.json': JSON.stringify({
      commands: Object.fromEntries(['begin', 'silent', 'end'].map((id) => [id, { argv: [process.execPath, `${id}.mjs`], effects: 'none' }])),
    }),
  });
  const claimLines = [1, 4, 5, 6];

  const json = run(root, ['check', '--json']);
  assert.equal(json.status, 1, json.stdout + json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.claims.length, parsed.summary.total);
  assert.deepEqual(parsed.claims.map(({ line }) => line), claimLines);

  const text = run(root, ['check', '--format', 'text']);
  assert.equal(text.status, 1);
  for (const line of claimLines) assert.match(text.stdout, new RegExp(`^line ${line}: `, 'm'), text.stdout);

  const github = run(root, ['check', '--format', 'github']);
  assert.equal(github.status, 1);
  assert.deepEqual(
    annotations(github.stdout).map((line) => line.match(/^::error file=README\.md,line=(\d+)::/)?.[1]),
    ['4', '5', '6'],
  );

  const regenRoot = withRepo(t, lines('# Demo'), {
    '.freshreadme.json': JSON.stringify({
      commands: {},
      regions: Object.fromEntries([KEY_BEGIN, 'quiet', KEY_END].map((id) => [id, { command: 'missing' }])),
    }),
  });
  const regen = run(regenRoot, ['regen']);
  assert.equal(regen.status, 2, regen.stdout + regen.stderr);
  assert.deepEqual(
    regen.stderr.split('\n').filter((line) => line.startsWith('error: ')),
    [KEY_BEGIN, 'quiet', KEY_END].map((id) => `error: region "${id}": command "missing" is not declared in commands`),
  );
});

test('a complete key inside a single message is still redacted in every check format', (t) => {
  const secret = 'MIIEsecretKeyMaterial';
  const root = withRepo(t, lines('# Demo', '', '```sh', '{node} key.mjs', '```'), {
    'key.mjs': failWith(`before ${KEY_BEGIN}\n${secret}\n${KEY_END} after`),
    '.freshreadme.json': JSON.stringify({ commands: { key: { argv: [process.execPath, 'key.mjs'], effects: 'none' } } }),
  });
  for (const args of [['check', '--json'], ['check', '--format', 'text'], ['check', '--format', 'github']]) {
    const result = run(root, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.ok(result.stdout.includes('before [redacted] after'), result.stdout);
    assert.ok(!result.stdout.includes(secret), result.stdout);
    assert.ok(!result.stdout.includes('PRIVATE KEY'), result.stdout);
  }
});

test('a configuration error exits 2 and is printed as ::error:: under the github format', (t) => {
  const broken = run(withRepo(t, OK_README, { '.freshreadme.json': '{ not json' }), ['check', '--format', 'github']);
  assert.equal(broken.status, 2);
  assert.match(broken.stdout, /^::error::\.freshreadme\.json: /m);

  const shell = JSON.stringify({ commands: { x: { argv: ['sh', '-c', 'true'], effects: 'none' } } });
  const refused = run(withRepo(t, OK_README, { '.freshreadme.json': shell }), ['check'], { GITHUB_ACTIONS: 'true' });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /^::error::command "x": shell interpreter "sh" is not allowed as argv\[0\]$/m);
});

test('unknown commands and flags print usage to stderr and exit 2', (t) => {
  const root = withRepo(t, OK_README);
  for (const args of [[], ['bogus'], ['check', '--nope'], ['check', '--format', 'xml'], ['regen', '--force'], ['--help', 'extra']]) {
    const result = run(root, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: freshreadme <command> \[options\]/);
  }
});

const ARGV_PAYLOADS = [...['\n', '\r\n', '\r', '\u0085'].map((sep) => `x${sep}::error::x`), `x ##[error]x`];

test('argv text in a usage error cannot start a workflow command under GITHUB_ACTIONS=true', (t) => {
  const root = withRepo(t, OK_README);
  const help = run(root, ['--help']).stdout;
  for (const payload of ARGV_PAYLOADS) {
    for (const [args, message] of [
      [['check', payload], `unknown option "${payload}" for check`],
      [['regen', payload], `unknown option "${payload}" for regen`],
      [[payload], `unknown command or option "${payload}"`],
    ]) {
      const label = JSON.stringify(args);
      const result = run(root, args, { GITHUB_ACTIONS: 'true' });
      assert.equal(result.status, 2, label);
      assertNoCommands(result.stderr);

      const plain = run(root, args);
      assert.equal(plain.status, 2, label);
      assert.equal(plain.stderr, `freshreadme: ${message}\n\n${help}`, label);
    }
  }
});

test('--help prints usage to stdout and exits 0', (t) => {
  const result = run(withRepo(t, OK_README), ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ {4}Usage: freshreadme <command> \[options\]$/m);
  assert.equal(result.stderr, '');
});

test('regen reports an out-of-date region, and regen --write rewrites it', (t) => {
  const root = withRepo(t, lines('# Demo', '', '<!-- freshreadme:begin out -->', 'stale', '<!-- freshreadme:end out -->'));
  const stale = run(root, ['regen']);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /README\.md: region "out" is out of date/);
  endsWithNote(stale.stdout);

  const written = run(root, ['regen', '--write']);
  assert.equal(written.status, 0);
  endsWithNote(written.stdout);
  assert.equal(
    readFileSync(path.join(root, 'README.md'), 'utf8'),
    lines('# Demo', '', '<!-- freshreadme:begin out -->', 'ok', '<!-- freshreadme:end out -->'),
  );

  const fresh = run(root, ['regen']);
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /every region is up to date/);
  endsWithNote(fresh.stdout);

  const broken = run(withRepo(t, OK_README, { '.freshreadme.json': '{ not json' }), ['regen']);
  assert.equal(broken.status, 2);
  assert.equal(broken.stdout, '');
  endsWithNote(broken.stderr);
});

test('a README with a GIF is unverifiable prose: nothing is spawned and nothing claims it was rendered', (t) => {
  const root = withRepo(t, fixture('gif.md'));
  const calls = [];
  const result = check({
    repoRoot: root,
    spawn: (...args) => {
      calls.push(args);
      return spawnSync(...args);
    },
  });
  assert.deepEqual(
    result.claims.map(({ line, class: kind, status }) => ({ line, class: kind, status })),
    [
      { line: 1, class: 'prose', status: J },
      { line: 3, class: 'prose', status: J },
    ],
  );
  assert.deepEqual(calls, []);

  for (const args of [['check'], ['check', '--format', 'github'], ['check', '--json']]) {
    const output = run(root, args);
    assert.equal(output.status, 0, args.join(' '));
    assert.doesNotMatch(output.stdout, /render/i);
    assert.doesNotMatch(output.stdout, /fully verified: all/);
    assert.doesNotMatch(output.stdout, /gif/i);
  }
  assert.match(run(root, ['check']).stdout, /^line 3: prose unverifiable: judgement \(needs human judgement\)$/m);
});

test("FreshReadme's own README checks with no mismatch and no out-of-date region", () => {
  const result = run(ROOT, ['check', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { summary, claims } = JSON.parse(result.stdout);
  assert.equal(summary.mismatch, 0);
  assert.ok(claims.some((claim) => claim.class === 'region' && claim.status === 'verified'));
  assert.ok(claims.some((claim) => claim.class === 'command' && claim.status === 'verified'));

  const regenerated = run(ROOT, ['regen']);
  assert.equal(regenerated.status, 0, regenerated.stdout + regenerated.stderr);
  assert.match(regenerated.stdout, /every region is up to date/);
});

test('npm test runs the unit tests and then the README check', () => {
  const { scripts } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(scripts.test, /\bnode --test\b/);
  assert.match(scripts.test, /\bnode bin\/freshreadme\.js check\b/);
});
