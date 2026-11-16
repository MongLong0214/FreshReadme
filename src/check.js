import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isInside, loadConfig } from './config.js';
import { parseMarkdown } from './markdown.js';
import { parseRegions } from './regions.js';
import { runDeclared } from './runner.js';

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console']);
const JUDGEMENT = 'unverifiable: judgement';
const NOT_ALLOWLISTED = 'unverifiable: not-allowlisted';
const SHELL_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;

// Strips only what a shell itself separates words with (and a CR left by CRLF); trim() would also drop
// U+00A0 and other Unicode whitespace that a shell keeps as part of an argument.
const stripShell = (text) => text.replace(/\r$/, '').replace(/^[ \t]+|[ \t]+$/g, '');

// The text regen --write puts between a region's markers; mirrors render in src/regen.js.
// CRs before a line break or at the end are dropped, so no output can make an LF README look CRLF.
export const renderRegion = (stdout, eol) => {
  const body = String(stdout).replace(/\r*\n/g, '\n').replace(/[\r\n]+$/, '');
  return body === '' ? '' : `${body}\n`.replace(/\n/g, eol);
};

const summarize = (claims) => ({
  total: claims.length,
  verified: claims.filter((claim) => claim.status === 'verified').length,
  mismatch: claims.filter((claim) => claim.status === 'mismatch').length,
  unverifiable: claims.filter((claim) => claim.status.startsWith('unverifiable')).length,
});

const fail = (errors) => ({ exitCode: 2, fullyVerified: false, claims: [], summary: summarize([]), errors });

const claim = (line, endLine, kind, status, detail) =>
  endLine === undefined ? { line, class: kind, status, detail } : { line, endLine, class: kind, status, detail };

// Why a fact does not hold, or null when it does.
const factFailure = (repoRoot, fact) => {
  let source;
  try {
    const file = realpathSync(path.resolve(repoRoot, fact.file));
    if (!isInside(realpathSync(repoRoot), file)) return `${fact.file} is outside the repository`;
    source = readFileSync(file, 'utf8');
  } catch (error) {
    return `${fact.file}: ${error.message}`;
  }
  if ('contains' in fact) {
    return source.includes(fact.contains) ? null : `${fact.file} does not contain "${fact.contains}"`;
  }
  let value;
  try {
    value = fact.json
      .split('.')
      .reduce((node, key) => (node !== null && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined), JSON.parse(source));
  } catch (error) {
    return `${fact.file}: ${error.message}`;
  }
  return value === fact.equals ? null : `${fact.file} ${fact.json} is ${JSON.stringify(value)}, expected ${JSON.stringify(fact.equals)}`;
};

export const check = ({ repoRoot, readmePath = 'README.md', spawn } = {}) => {
  const loaded = loadConfig(repoRoot);
  if (!loaded.ok) return fail(loaded.errors);
  const { config } = loaded;

  const file = path.resolve(repoRoot, readmePath);
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return fail([`${readmePath}: ${error.message}`]);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return fail([`${readmePath}: is not valid UTF-8`]);

  const parsed = parseRegions(text, config);
  if (!parsed.ok) return fail(parsed.errors.map((error) => `${readmePath}: ${error}`));

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const byText = new Map();
  for (const [id, { argv }] of Object.entries(config.commands)) {
    // Only argv a shell reads back as the same words can be matched from README text.
    if (!argv.every((arg) => SHELL_WORD.test(arg))) continue;
    const key = argv.join(' ');
    if (!byText.has(key)) byText.set(key, id);
  }
  const errors = [];
  const run = (commandId) => runDeclared(config, commandId, { repoRoot, spawn });

  const regionClaim = ({ id, line, endLine, body }) => {
    const commandId = config.regions[id].command;
    const result = run(commandId);
    if (result.reason === 'ok') {
      return body === renderRegion(result.stdout, eol)
        ? claim(line, endLine, 'region', 'verified', `matches the output of command "${commandId}"`)
        : claim(line, endLine, 'region', 'mismatch', `differs from the output of command "${commandId}"`);
    }
    if (result.reason === 'nonzero') return claim(line, endLine, 'region', 'mismatch', result.message);
    errors.push(`region "${id}": ${result.message}`);
    return claim(line, endLine, 'region', `unverifiable: ${result.reason}`, result.message);
  };

  const commandClaim = ({ line, text: raw }) => {
    const commandId = byText.get(stripShell(stripShell(raw).replace(/^\$ /, '')));
    if (commandId === undefined) return claim(line, undefined, 'command', NOT_ALLOWLISTED, 'matches no declared command; not run');
    const result = run(commandId);
    if (result.reason === 'ok') return claim(line, undefined, 'command', 'verified', result.message);
    if (result.reason === 'nonzero') return claim(line, undefined, 'command', 'mismatch', result.message);
    errors.push(result.message);
    return claim(line, undefined, 'command', `unverifiable: ${result.reason}`, result.message);
  };

  // A line verifies only when, without list or blockquote markers, it is exactly a fact's text.
  const lineClaim = ({ line, text: content }) => {
    const stated = content.replace(/^(?:\s*(?:[-*+] |\d+\. |> ))*\s*/, '').trimEnd();
    const facts = config.facts.filter((fact) => stated.includes(fact.text));
    if (facts.length === 0) return claim(line, undefined, 'prose', JUDGEMENT, 'needs human judgement');
    const failures = facts.map((fact) => factFailure(repoRoot, fact)).filter(Boolean);
    if (failures.length > 0) return claim(line, undefined, 'fact', 'mismatch', failures.join('; '));
    const ids = facts.map((fact) => `"${fact.id}"`).join(', ');
    return facts.some((fact) => fact.text === stated)
      ? claim(line, undefined, 'fact', 'verified', `fact ${ids} holds`)
      : claim(line, undefined, 'fact', 'unverifiable: partial-fact', `fact ${ids} holds, but the line says more than the fact covers`);
  };

  const classify = (record) => {
    switch (record.kind) {
      case 'blank':
        return [];
      case 'region':
        return [regionClaim(record)];
      case 'fence':
        return SHELL_LANGS.has(record.lang)
          ? record.content.filter(({ text: content }) => stripShell(content) !== '').map(commandClaim)
          : [claim(record.line, record.endLine, 'prose', JUDGEMENT, 'needs human judgement')];
      default:
        return [lineClaim(record)];
    }
  };

  const claims = parseMarkdown(text).flatMap(classify);
  const summary = summarize(claims);
  const exitCode = errors.length > 0 ? 2 : summary.mismatch > 0 ? 1 : 0;
  return { exitCode, fullyVerified: exitCode === 0 && summary.unverifiable === 0, claims, summary, errors };
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const formatText = ({ fullyVerified, claims, summary, errors }) => {
  const lines = claims.map(({ line, endLine, class: kind, status, detail }) => {
    const where = endLine !== undefined && endLine !== line ? `lines ${line}-${endLine}` : `line ${line}`;
    return `${where}: ${kind} ${status}${detail ? ` (${detail})` : ''}`;
  });
  lines.push(...errors.map((error) => `error: ${error}`));
  if (fullyVerified) {
    lines.push(`The README is fully verified: all ${plural(summary.total, 'claim')} verified.`);
  } else if (claims.length === 0 && errors.length > 0) {
    lines.push('The README is not fully verified: it could not be checked.');
  } else {
    lines.push(
      `The README is not fully verified: ${summary.unverifiable} of ${plural(summary.total, 'claim')} unverifiable, ` +
        `${summary.mismatch} mismatched, ${summary.verified} verified.`,
    );
  }
  return lines.join('\n');
};
