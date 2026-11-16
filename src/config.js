import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.freshreadme.json';
export const DEFAULT_TIMEOUT_MS = 10000;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const INSTALL_VERBS = new Set(['install', 'i', 'ci', 'add']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const programName = (arg) => path.basename(arg).toLowerCase().replace(/\.(exe|cmd)$/, '');

export const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const refuse = (errors) => ({ ok: false, exitCode: 2, errors });

const checkCwd = (label, cwd, repoReal) => {
  if (!isNonEmptyString(cwd)) return [`${label}: cwd must be a non-empty relative path`];
  if (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) return [`${label}: cwd "${cwd}" must be relative to the repository root`];
  if (cwd.includes('..')) return [`${label}: cwd "${cwd}" must not contain ".."`];
  let real;
  try {
    real = realpathSync(path.resolve(repoReal, cwd));
  } catch {
    return [`${label}: cwd "${cwd}" does not exist`];
  }
  if (!isInside(repoReal, real)) return [`${label}: cwd "${cwd}" resolves outside the repository`];
  if (!statSync(real).isDirectory()) return [`${label}: cwd "${cwd}" is not a directory`];
  return [];
};

const checkCommand = (id, command, repoReal) => {
  const label = `command "${id}"`;
  if (!isObject(command)) return [`${label}: must be an object`];
  const { argv, cwd = '.', effects, timeoutMs } = command;
  const errors = [];
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => isNonEmptyString(arg) && !arg.includes('\0'))) {
    errors.push(`${label}: argv must be a non-empty array of non-empty strings`);
  } else {
    const program = programName(argv[0]);
    const args = argv.slice(1);
    if (SHELLS.has(program)) errors.push(`${label}: shell interpreter "${program}" is not allowed as argv[0]`);
    if (PACKAGE_MANAGERS.has(program) && args.some((arg) => INSTALL_VERBS.has(arg))) {
      errors.push(`${label}: package installs are not allowed`);
    }
    if (program === 'git' && args.includes('push')) errors.push(`${label}: git push is not allowed`);
  }
  if (effects !== 'none') errors.push(`${label}: effects must be "none"`);
  if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    errors.push(`${label}: timeoutMs must be a positive integer`);
  }
  return [...errors, ...checkCwd(label, cwd, repoReal)];
};

const checkFact = (fact, index) => {
  if (!isObject(fact)) return [`fact ${index}: must be an object`];
  // A non-string id is never interpolated: an object without toString would throw here.
  const label = isNonEmptyString(fact.id) ? `fact "${fact.id}"` : `fact ${index}`;
  const errors = ['id', 'text', 'file']
    .filter((key) => !isNonEmptyString(fact[key]))
    .map((key) => `${label}: ${key} must be a non-empty string`);
  const jsonForm = 'json' in fact || 'equals' in fact;
  const containsForm = 'contains' in fact;
  if (jsonForm === containsForm) {
    errors.push(`${label}: must have exactly one of json+equals or contains`);
  } else if (jsonForm && !(isNonEmptyString(fact.json) && typeof fact.equals === 'string')) {
    errors.push(`${label}: json must be a non-empty dot path and equals a string`);
  } else if (containsForm && !isNonEmptyString(fact.contains)) {
    errors.push(`${label}: contains must be a non-empty string`);
  }
  return errors;
};

export const loadConfig = (repoRoot) => {
  const file = path.join(repoRoot, CONFIG_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, config: { commands: {}, regions: {}, facts: [] } };
    return refuse([`${CONFIG_FILE}: ${error.message}`]);
  }
  if (!isObject(raw)) return refuse([`${CONFIG_FILE}: must contain a JSON object`]);

  const { commands = {}, regions = {}, facts = [] } = raw;
  if (!isObject(commands)) return refuse([`${CONFIG_FILE}: commands must be an object`]);
  if (!isObject(regions)) return refuse([`${CONFIG_FILE}: regions must be an object`]);
  if (!Array.isArray(facts)) return refuse([`${CONFIG_FILE}: facts must be an array`]);

  const repoReal = realpathSync(repoRoot);
  const errors = [
    ...Object.entries(commands).flatMap(([id, command]) => checkCommand(id, command, repoReal)),
    ...Object.entries(regions).flatMap(([id, region]) => {
      if (!isObject(region) || !isNonEmptyString(region.command)) return [`region "${id}": command must be a non-empty string`];
      return Object.hasOwn(commands, region.command) ? [] : [`region "${id}": command "${region.command}" is not declared in commands`];
    }),
    ...facts.flatMap(checkFact),
  ];
  if (errors.length > 0) return refuse(errors);

  const declared = Object.fromEntries(
    Object.entries(commands).map(([id, { argv, cwd = '.', effects, timeoutMs = DEFAULT_TIMEOUT_MS }]) => [
      id,
      { argv, cwd, effects, timeoutMs },
    ]),
  );
  return { ok: true, config: { commands: declared, regions, facts } };
};
