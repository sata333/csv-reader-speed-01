// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's answer for every input —
// {columns, rows, errors} under make.fun's broken-row policy — but reads the text in slices instead of a
// character at a time. The text is scanned once, left to right, with charCodeAt; a field's value is taken as
// one slice of the input whenever the field is clean, and assembled from pieces only when the broken-row
// policy forces edits (a dropped stray CR, a doubled quote, a CR inside quotes read as LF).
//
// The policy, matched exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote,
//     each CRLF or lone CR inside it is read as LF); what follows the closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, raised when the field ends, and only when at least
//     one character was actually appended); a quote that never closes is a literal character and the text
//     after it is re-read as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on (every
//     LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows (null for the
//     header); a record's short_row/long_row is raised when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

const CH_COMMA = 44;
const CH_LF = 10;
const CH_CR = 13;
const CH_QUOTE = 34;

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next '"' and the next CR in the text, as found from the position each was last computed at
  // (-2: not computed yet; -1: none left in the text). pos only ever moves forward, so a cached index
  // that is still >= pos is still the first occurrence at or after pos, a cached -1 stays -1, and each
  // is recomputed with indexOf only once pos has passed it: every region of the text is then scanned a
  // bounded number of times overall. (Asking indexOf afresh on every record scans to the end of the
  // text whenever the character is absent, which makes reading quote-free or CR-free data quadratic.)
  let nextQ = -2;
  let nextR = -2;

  // The field just read: its value, how it ended, and how many characters its last unquoted stretch kept.
  let fVal = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Sets fVal, fEnded and fAdded (the characters kept by this read, not counting init).
  function readUnquoted(init) {
    let pieces = null; // slices kept so far, once a stray CR has split the field
    let added = 0;
    let start = pos;
    let i = pos;
    for (;;) {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === CH_COMMA || c === CH_LF || c === CH_CR) break;
        i += 1;
      }
      if (i >= n) {
        fVal = pieces === null ? init + text.slice(start, i) : init + (pieces.push(text.slice(start, i)), pieces.join(''));
        fAdded = added + (i - start);
        pos = i;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(i);
      if (c === CH_COMMA || c === CH_LF || (c === CH_CR && i + 1 < n && text.charCodeAt(i + 1) === CH_LF)) {
        fVal = pieces === null ? init + text.slice(start, i) : init + (pieces.push(text.slice(start, i)), pieces.join(''));
        fAdded = added + (i - start);
        if (c === CH_COMMA) {
          pos = i + 1;
          fEnded = COMMA;
        } else if (c === CH_LF) {
          pos = i + 1;
          line += 1;
          fEnded = BREAK;
        } else {
          pos = i + 2;
          line += 1;
          fEnded = BREAK;
        }
        return;
      }
      // A CR not followed by LF: dropped, and the field is assembled from pieces from here on.
      error('stray_cr');
      if (pieces === null) pieces = [];
      pieces.push(text.slice(start, i));
      added += i - start;
      i += 1;
      start = i;
    }
  }

  // What follows a closing quote: the field ends at once at a comma, a line break or the end of the text;
  // anything else is appended as it stands (quote_junk, when the field ends, if anything was appended).
  // fVal already holds the quoted value and pos is just past the closing quote.
  function finishQuoted() {
    if (pos >= n) {
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === CH_COMMA) {
      pos += 1;
      fEnded = COMMA;
      return;
    }
    if (c === CH_LF) {
      pos += 1;
      line += 1;
      fEnded = BREAK;
      return;
    }
    if (c === CH_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CH_LF) {
      pos += 2;
      line += 1;
      fEnded = BREAK;
      return;
    }
    const value = fVal;
    readUnquoted(value);
    if (fAdded > 0) error('quote_junk');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Fast path: the next quote is the closing quote and the value between them holds no CR. The tests
    // run on the value slice itself, so they scan the field and nothing beyond it.
    const close = text.indexOf('"', open + 1);
    if (close !== -1 && text.charCodeAt(close + 1) !== CH_QUOTE) {
      const value = text.slice(open + 1, close);
      if (!value.includes('\r')) {
        // Count the LFs inside for the line tally.
        let k = -1;
        while ((k = value.indexOf('\n', k + 1)) !== -1) line += 1;
        fVal = value;
        pos = close + 1;
        finishQuoted();
        return;
      }
    }
    // Slow path: doubled quotes or CRs inside — assemble the value from pieces.
    const pieces = [];
    let i = open + 1;
    let seg = i;
    let closed = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === CH_QUOTE) {
        if (i + 1 < n && text.charCodeAt(i + 1) === CH_QUOTE) {
          pieces.push(text.slice(seg, i), '"');
          i += 2;
          seg = i;
          continue;
        }
        pieces.push(text.slice(seg, i));
        i += 1;
        closed = true;
        break;
      }
      if (c === CH_CR) {
        pieces.push(text.slice(seg, i), '\n');
        line += 1;
        i += i + 1 < n && text.charCodeAt(i + 1) === CH_LF ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === CH_LF) line += 1;
      i += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquoted('"');
      return;
    }
    fVal = pieces.join('');
    pos = i;
    finishQuoted();
  }

  // Closes a record: the first one sets the width (and is the columns when header is true); each later one
  // is padded or cut to the width, its short_row/long_row raised here, and appended to rows.
  function endRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CH_LF) {
        pos += 1;
        line += 1;
      } else if (c === CH_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CH_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the whole record sits on one physical line with no quote and no CR in it but the CR of a
    // closing CRLF. Then no field can be quoted, no error can arise while reading it, and its fields are
    // simply the line cut at its commas. (A quote anywhere on the line, or a CR anywhere else, sends the
    // record down the general path below, which reads it field by field.)
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    if (nextQ !== -1 && nextQ < pos) nextQ = text.indexOf('"', pos);
    if (nextQ === -1 || nextQ >= lineEnd) {
      if (nextR !== -1 && nextR < pos) nextR = text.indexOf('\r', pos);
      if (nextR === -1 || (lf !== -1 && nextR === lineEnd - 1)) {
        const contentEnd = nextR === -1 ? lineEnd : lineEnd - 1;
        const fields = [];
        let fstart = pos;
        for (;;) {
          const cm = text.indexOf(',', fstart);
          if (cm === -1 || cm >= contentEnd) {
            fields.push(text.slice(fstart, contentEnd));
            break;
          }
          fields.push(text.slice(fstart, cm));
          fstart = cm + 1;
        }
        pos = lf === -1 ? n : lf + 1;
        if (lf !== -1) line += 1;
        endRecord(fields);
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === CH_QUOTE;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fVal);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    endRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
