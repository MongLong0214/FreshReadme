const MARKER = /^<!--\s*freshreadme:(begin|end)\s+(\S+?)\s*-->$/;

// Lines without their terminators; eol is '\r\n', '\n', or '' for a last line with no final newline.
export const splitLines = (text) => {
  const lines = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n/g)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' });
  return lines;
};

export const parseRegions = (text, config) => {
  const declared = config?.regions ?? {};
  const errors = [];
  const regions = [];
  const seen = new Set();
  let open = null;

  splitLines(text).forEach(({ text: line }, index) => {
    const lineNumber = index + 1;
    const match = MARKER.exec(line);
    if (!match) {
      open?.lines.push(line);
      return;
    }
    const [, kind, id] = match;
    if (kind === 'begin') {
      if (open) {
        errors.push(`line ${lineNumber}: region "${id}" begins inside region "${open.id}" (line ${open.beginLine}); regions cannot nest`);
        return;
      }
      if (seen.has(id)) errors.push(`line ${lineNumber}: region "${id}" is declared more than once`);
      if (!Object.hasOwn(declared, id)) errors.push(`line ${lineNumber}: region "${id}" is not declared in config regions`);
      seen.add(id);
      open = { id, beginLine: lineNumber, lines: [] };
      return;
    }
    if (open?.id !== id) {
      errors.push(`line ${lineNumber}: end of region "${id}" has no matching begin`);
      return;
    }
    regions.push({
      id,
      beginLine: open.beginLine,
      endLine: lineNumber,
      content: open.lines.map((inner) => `${inner}\n`).join(''),
    });
    open = null;
  });

  if (open) errors.push(`line ${open.beginLine}: region "${open.id}" is never closed`);
  return errors.length > 0 ? { ok: false, exitCode: 2, errors } : { ok: true, regions };
};
