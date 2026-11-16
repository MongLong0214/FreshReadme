import { splitLines } from './regions.js';

const MARKER = /^<!--\s*freshreadme:(begin|end)\s+(\S+?)\s*-->$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

const closes = (line, fence) => {
  const match = FENCE_CLOSE.exec(line);
  return Boolean(match) && match[1][0] === fence.char && match[1].length >= fence.size;
};

const openFence = (line, lineNumber) => {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const [, delimiter, rest] = match;
  const info = rest.trim();
  if (delimiter[0] === '`' && info.includes('`')) return null;
  const record = { kind: 'fence', line: lineNumber, endLine: lineNumber, info, lang: info.split(/\s+/)[0].toLowerCase(), content: [] };
  return { record, char: delimiter[0], size: delimiter.length };
};

// Records in file order with 1-based line numbers:
//   blank  { line }
//   text   { line, text }                              an ordinary line
//   fence  { line, endLine, info, lang, content }      delimiters included; content is [{ line, text }]
//   region { id, line, endLine, body }                 begin..end markers; body is the raw text between them
//   marker { line, text, marker, id }                  a marker that does not pair up
// Markers are recognised on every line, as src/regions.js does, so a marker also ends an open fence.
// An unclosed fence runs to the end of the file; an unclosed region keeps endLine null.
export const parseMarkdown = (text) => {
  const records = [];
  let fence = null;
  let region = null;

  splitLines(text).forEach(({ text: line, eol }, index) => {
    const lineNumber = index + 1;
    const marker = MARKER.exec(line);
    if (marker) {
      const [, kind, id] = marker;
      fence = null;
      if (kind === 'begin' && !region) {
        region = { kind: 'region', id, line: lineNumber, endLine: null, body: '' };
        records.push(region);
      } else if (kind === 'end' && region?.id === id) {
        region.endLine = lineNumber;
        region = null;
      } else {
        records.push({ kind: 'marker', line: lineNumber, text: line, marker: kind, id });
      }
      return;
    }
    if (region) {
      region.body += line + eol;
      return;
    }
    if (fence) {
      fence.record.endLine = lineNumber;
      if (closes(line, fence)) fence = null;
      else fence.record.content.push({ line: lineNumber, text: line });
      return;
    }
    fence = openFence(line, lineNumber);
    if (fence) records.push(fence.record);
    else if (line.trim() === '') records.push({ kind: 'blank', line: lineNumber });
    else records.push({ kind: 'text', line: lineNumber, text: line });
  });

  return records;
};
