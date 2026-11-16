#!/usr/bin/env node
import { check, formatText } from '../src/check.js';
import { regen } from '../src/regen.js';
import { EFFECTS_NOTE, redact } from '../src/runner.js';

const README = 'README.md';
const NOTE_LINE = `note: ${EFFECTS_NOTE}`;

// Indented so the copy regenerated into the README renders as a code block.
const HELP = `${[
  '    Usage: freshreadme <command> [options]',
  '',
  '    Commands:',
  '      check [--json] [--format text|github]   check every README claim against the repository',
  '      regen [--write]                         report regions that are out of date; --write rewrites them',
  '      --help                                  print this help',
  '',
  '    The github format prints ::error annotations; it is the default when GITHUB_ACTIONS=true.',
  '    Commands, regions and facts are declared in .freshreadme.json in the current directory.',
  '',
  '    Exit codes: 0 no mismatch, 1 mismatch, 2 usage, configuration or run error.',
].join('\n')}\n`;

// GitHub workflow command messages must not carry raw %, CR or LF; properties also not : or ,.
const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

// Mismatches are errors and unverifiable claims notices; verified claims get no annotation.
// Only annotations and the summary line: claim details and errors carry child output,
// which on a line of its own would be read as a workflow command.
const formatGithub = (result) =>
  [
    ...result.claims
      .filter((claim) => claim.status === 'mismatch')
      .map(
        (claim) =>
          `::error file=${escapeProperty(README)},line=${escapeProperty(claim.line)}::${escapeData(claim.detail)}`,
      ),
    ...result.claims
      .filter((claim) => claim.status.startsWith('unverifiable'))
      .map(
        (claim) =>
          `::notice file=${escapeProperty(README)},line=${escapeProperty(claim.line)}::${escapeData(`${claim.class} ${claim.status} (${claim.detail})`)}`,
      ),
    ...result.errors.map((error) => `::error::${escapeData(error)}`),
    formatText(result).split('\n').at(-1),
  ].join('\n');

// Under Actions, plain text carries child output. The runner reads a line as a command when it starts
// (after whitespace) with :: or when it contains ##[ anywhere, so ##[ becomes "# #[" and every line gets
// a "| " prefix: no whitespace test, since the runner's whitespace set differs from JavaScript's.
// CR, CRLF and LF all end a runner line; a final line break stays a single trailing LF.
const LEGACY = '##[';
const underActions = () => process.env.GITHUB_ACTIONS === 'true';
const neutralizeCommands = (text) => {
  if (!underActions()) return text;
  const lines = text.split(/\r\n|\r|\n/);
  const trailing = lines.length > 1 && lines.at(-1) === '';
  if (trailing) lines.pop();
  return `${lines.map((line) => `| ${line.replaceAll(LEGACY, '# #[')}`).join('\n')}${trailing ? '\n' : ''}`;
};

// In serialized JSON, # and [ only occur literally inside strings, so escaping the second # as #
// removes ##[ from the raw text while JSON.parse returns the same value.
const neutralizeJson = (json) => (underActions() ? json.replaceAll(LEGACY, '#\\u0023[') : json);

// The message quotes argv text, so under Actions it is neutralized like every other diagnostic.
const usageError = (message) => {
  process.stderr.write(neutralizeCommands(`freshreadme: ${message}\n\n${HELP}`));
  return 2;
};

const parseCheck = (args) => {
  const options = { json: false, format: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--format' || arg.startsWith('--format=')) {
      const value = arg === '--format' ? args[(index += 1)] : arg.slice('--format='.length);
      if (value !== 'text' && value !== 'github') return { error: '--format must be text or github' };
      options.format = value;
    } else {
      return { error: `unknown option "${arg}" for check` };
    }
  }
  return { options };
};

const runCheck = (args) => {
  const { options, error } = parseCheck(args);
  if (error) return usageError(error);
  const checked = check({ repoRoot: process.cwd(), readmePath: README });
  const format = options.format ?? (underActions() ? 'github' : 'text');
  // Each field is redacted on its own: a key pattern run over the assembled report could span
  // from one claim's text into another's and erase every claim in between.
  const claims = checked.claims.map((claim) => ({ ...claim, detail: redact(claim.detail) }));
  const errors = checked.errors.map(redact);
  const result = { ...checked, claims, errors };
  const { exitCode, fullyVerified, summary } = result;
  let printed;
  if (options.json) {
    printed = neutralizeJson(
      JSON.stringify({ exitCode, fullyVerified, summary, claims, errors, effectsNote: EFFECTS_NOTE }, null, 2),
    );
  } else if (format === 'github') {
    printed = `${formatGithub(result)}\n${NOTE_LINE}`;
  } else {
    printed = neutralizeCommands(`${formatText(result)}\n${NOTE_LINE}`);
  }
  process.stdout.write(`${printed}\n`);
  return exitCode;
};

const runRegen = (args) => {
  const unknown = args.find((arg) => arg !== '--write');
  if (unknown !== undefined) return usageError(`unknown option "${unknown}" for regen`);
  const result = regen({ repoRoot: process.cwd(), readmePath: README, write: args.includes('--write') });
  if (result.errors.length > 0) {
    process.stderr.write(
      neutralizeCommands(`${result.errors.map((error) => `error: ${redact(error)}`).join('\n')}\n${NOTE_LINE}\n`),
    );
  } else {
    process.stdout.write(neutralizeCommands(`${redact(result.output) || `${README}: every region is up to date`}\n${NOTE_LINE}\n`));
  }
  return result.exitCode;
};

const main = ([command, ...args]) => {
  if (command === '--help' && args.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'check') return runCheck(args);
  if (command === 'regen') return runRegen(args);
  return usageError(command === undefined ? 'missing command' : `unknown command or option "${command}"`);
};

process.exitCode = main(process.argv.slice(2));
