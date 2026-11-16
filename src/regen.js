import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, loadConfig } from './config.js';
import { parseRegions, splitLines } from './regions.js';
import { runDeclared } from './runner.js';

const fail = (errors) => ({ exitCode: 2, changed: [], output: '', errors });

// Exactly one trailing newline (none for empty output), in the file's line ending.
// CRs before a line break or at the end are dropped, so no output can make an LF README look CRLF.
const render = (stdout, eol) => {
  const body = String(stdout).replace(/\r*\n/g, '\n').replace(/[\r\n]+$/, '');
  return body === '' ? '' : `${body}\n`.replace(/\n/g, eol);
};

export const regen = ({ repoRoot, readmePath = 'README.md', write = false, spawn, fs = {} } = {}) => {
  const loaded = loadConfig(repoRoot);
  if (!loaded.ok) return fail(loaded.errors);
  const { config } = loaded;

  const io = { ...nodeFs, ...fs };
  const file = path.resolve(repoRoot, readmePath);
  const outsideRepo = () => fail([`${readmePath}: resolves outside the repository`]);
  // The README's real path when it lies inside the real repository root, else undefined.
  const resolveInside = () => {
    try {
      const real = io.realpathSync(file);
      return isInside(io.realpathSync(repoRoot), real) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  const target = resolveInside();
  if (target === undefined) {
    // A README that does not exist at all keeps its read error below; anything else is refused.
    let exists = true;
    try {
      io.lstatSync(file);
    } catch {
      exists = false;
    }
    if (exists) return outsideRepo();
  }
  let bytes;
  try {
    bytes = readFileSync(target ?? file);
  } catch (error) {
    return fail([`${readmePath}: ${error.message}`]);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return fail([`${readmePath}: is not valid UTF-8`]);

  const parsed = parseRegions(text, config);
  if (!parsed.ok) return fail(parsed.errors.map((error) => `${readmePath}: ${error}`));

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const byBeginLine = new Map();
  for (const region of parsed.regions) {
    const result = runDeclared(config, config.regions[region.id].command, { repoRoot, spawn });
    if (!result.ok) return fail([`region "${region.id}": ${result.message}`]);
    byBeginLine.set(region.beginLine, { ...region, body: render(result.stdout, eol) });
  }

  const lines = splitLines(text);
  const joined = (from, to) => lines.slice(from, to).map((line) => line.text + line.eol).join('');
  const pieces = [];
  const changed = [];
  let index = 0;
  while (index < lines.length) {
    pieces.push(joined(index, index + 1));
    const region = byBeginLine.get(index + 1);
    if (region) {
      // Lines strictly between the markers: indexes beginLine .. endLine - 2.
      if (joined(region.beginLine, region.endLine - 1) !== region.body) changed.push(region.id);
      pieces.push(region.body);
      index = region.endLine - 1;
    } else {
      index += 1;
    }
  }
  const next = pieces.join('');

  // Output containing marker lines would change the document's regions; refuse it.
  const ids = (regions) => JSON.stringify(regions.map((region) => region.id));
  const reparsed = parseRegions(next, config);
  if (!reparsed.ok || ids(reparsed.regions) !== ids(parsed.regions)) {
    // With no declared regions, any marker line in a body is an error.
    const offender = [...byBeginLine.values()].find((region) => !parseRegions(region.body, {}).ok);
    return fail([
      offender
        ? `region "${offender.id}": command output contains a freshreadme marker line`
        : `${readmePath}: regenerated README would have invalid region markers`,
    ]);
  }

  if (!write) {
    const output = changed.map((id) => `${readmePath}: region "${id}" is out of date`).join('\n');
    return { exitCode: changed.length > 0 ? 1 : 0, changed, output, errors: [] };
  }
  if (next !== text) {
    // Write a sibling temp file and rename it over the README, so a failure never truncates it.
    let temp;
    try {
      const mode = io.statSync(target).mode & 0o7777;
      // A command may have retargeted a link during the run; write only to the path validated at the start.
      if (resolveInside() !== target) return outsideRepo();
      const random = randomBytes(6).toString('hex');
      const name = path.join(path.dirname(target), `.${path.basename(target)}.freshreadme-${process.pid}-${random}.tmp`);
      // Created with the README's mode (narrowed by umask) before any content exists; never reuse a file.
      const fd = io.openSync(name, 'wx', mode);
      temp = name;
      try {
        io.writeFileSync(fd, next);
      } finally {
        io.closeSync(fd);
      }
      io.chmodSync(temp, mode);
      io.renameSync(temp, target);
    } catch (error) {
      if (temp !== undefined) {
        try {
          io.unlinkSync(temp);
        } catch {
          // The temp file may never have been created.
        }
      }
      return fail([`${readmePath}: could not write: ${error.message}`]);
    }
  }
  const output = changed.map((id) => `${readmePath}: updated region "${id}"`).join('\n');
  return { exitCode: 0, changed, output, errors: [] };
};
