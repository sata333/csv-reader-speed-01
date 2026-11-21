// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's answer for every input —
// {columns, rows, errors} under make.fun's broken-row policy — but reads the text in slices instead of a
// character at a time. The text is scanned once, left to right; field ends are found with native indexOf
// searches (a fresh scan for the next comma, cached scans for the next quote, CR and LF), so a clean field
// costs one slice and no per-character loop. A field's value is taken as one slice of the input whenever
// the field is clean, and assembled from pieces only when the broken-row policy forces edits (a dropped
// stray CR, a doubled quote, a CR inside quotes read as LF).
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
function runJS(input) {
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
  let nextL = -2;

  // The field just read: its value, how it ended, and how many characters its last unquoted stretch kept.
  let fVal = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Sets fVal, fEnded and fAdded (the characters kept by this read, not counting init).
  // The end of the field is found with native searches: a fresh scan for the next comma (commas are
  // dense) and the cached next-CR / next-LF scans, so a clean field costs one slice and no per-character
  // loop. This reader never moves pos backwards, so the caches it advances stay valid.
  function readUnquoted(init) {
    let pieces = null; // slices kept so far, once a stray CR has split the field
    let added = 0;
    let start = pos;
    let i = pos;
    for (;;) {
      const cm = text.indexOf(',', i);
      if (nextR !== -1 && nextR < i) nextR = text.indexOf('\r', i);
      if (nextL !== -1 && nextL < i) nextL = text.indexOf('\n', i);
      // The common case: the field ends at its comma, with no CR or LF before it.
      if (pieces === null && cm !== -1 && (nextR === -1 || cm < nextR) && (nextL === -1 || cm < nextL)) {
        fVal = init + text.slice(start, cm);
        fAdded = added + (cm - start);
        pos = cm + 1;
        fEnded = COMMA;
        return;
      }
      let d = -1;
      let dc = -1;
      if (cm !== -1) { d = cm; dc = CH_COMMA; }
      if (nextR !== -1 && (d === -1 || nextR < d)) { d = nextR; dc = CH_CR; }
      if (nextL !== -1 && (d === -1 || nextL < d)) { d = nextL; dc = CH_LF; }
      if (d === -1) {
        fVal = pieces === null ? init + text.slice(start, n) : init + (pieces.push(text.slice(start, n)), pieces.join(''));
        fAdded = added + (n - start);
        pos = n;
        fEnded = END;
        return;
      }
      if (dc === CH_COMMA || dc === CH_LF || (dc === CH_CR && text.charCodeAt(d + 1) === CH_LF)) {
        fVal = pieces === null ? init + text.slice(start, d) : init + (pieces.push(text.slice(start, d)), pieces.join(''));
        fAdded = added + (d - start);
        if (dc === CH_COMMA) {
          pos = d + 1;
          fEnded = COMMA;
        } else if (dc === CH_LF) {
          pos = d + 1;
          line += 1;
          fEnded = BREAK;
        } else {
          pos = d + 2;
          line += 1;
          fEnded = BREAK;
        }
        return;
      }
      // A CR not followed by LF: dropped, and the field is assembled from pieces from here on.
      error('stray_cr');
      if (pieces === null) pieces = [];
      pieces.push(text.slice(start, d));
      added += d - start;
      i = d + 1;
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
    if (nextL !== -1 && nextL < pos) nextL = text.indexOf('\n', pos);
    const lf = nextL;
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

// ---------------------------------------------------------------------------
// WASM scanning offload: the text is copied once into WASM memory as UTF-16 code units
// (Buffer's utf16le conversion preserves lone surrogates exactly), a WASM scanner walks it
// once and writes a compact descriptor stream (field segments, literal characters, errors,
// record markers), and the consumer below slices the original string into the answer.
// Any failure — no Buffer, no WebAssembly, a trap — falls back to runJS above, unchanged.
// ---------------------------------------------------------------------------
const WASM_B64 = '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';
let wasmScan = null;
let wasmMem = null;
try {
  const wasmBytes = Buffer.from(WASM_B64, 'base64');
  const wasmInst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  wasmScan = wasmInst.exports.scan;
  wasmMem = wasmInst.exports.memory;
} catch (e) {
  wasmScan = null;
}

const ERR_CODES = ['stray_cr', 'quote_junk', 'unterminated_quote'];

function runWasm(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const streamOff = (2 * n + 3) & ~3;
  const need = streamOff + 24 * n + 65536;
  if (wasmMem.buffer.byteLength < need) {
    wasmMem.grow(Math.ceil((need - wasmMem.buffer.byteLength) / 65536));
  }
  // Write the text straight into WASM memory as UTF-16 code units (native String::Write;
  // preserves lone surrogates exactly). The view is created after any grow, never held across one.
  Buffer.from(wasmMem.buffer, 0, 2 * n).write(text, 0, 2 * n, 'utf16le');
  const words = wasmScan(n, streamOff);
  const view = new Uint32Array(wasmMem.buffer, streamOff, words);

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let i = 0;

  while (i < words) {
    // REC_START
    const curLine = view[i + 1];
    const curRow = header && columns === null ? null : rows.length;
    i += 2;
    const cap = width >= 0 ? width : 0;
    const fields = new Array(cap);
    let fi = 0;
    let lastQuoted = 0;
    let segState = 0; // 0: no pieces yet, 1: one segment pending, 2: assembling in parts
    let pStart = 0;
    let pLen = 0;
    let parts = null;
    for (;;) {
      let tag = view[i];
      if ((tag & 255) === 7) { // packed FIELD1 run: word = 7 | start<<8, next word = len | quoted<<24
        do {
          const st = tag >>> 8;
          const w1 = view[i + 1];
          const ln = w1 & 0xffffff;
          const v = ln === 0 ? '' : text.slice(st, st + ln);
          if (fi < cap) fields[fi] = v; else fields.push(v);
          fi++;
          lastQuoted = w1 >>> 24;
          i += 2;
          tag = view[i];
        } while ((tag & 255) === 7);
      }
      if (tag === 6) { // REC_END
        i += 1;
        if (!(fi === 1 && fields[0] === '' && !lastQuoted)) {
          if (width < 0) width = fi;
          if (header && columns === null) {
            columns = fields;
          } else if (fi < width) {
            errors.push({ code: 'short_row', line: curLine, row: curRow, fields: fi });
            for (let k = fi; k < width; k++) fields[k] = '';
            rows.push(fields);
          } else if (fi > width) {
            errors.push({ code: 'long_row', line: curLine, row: curRow, extra: fields.splice(width) });
            rows.push(fields);
          } else {
            rows.push(fields);
          }
        }
        break;
      }
      if (tag === 9) { // FIELD1X: one clean segment, unpacked (very large offset or field)
        const v = view[i + 2] === 0 ? '' : text.slice(view[i + 1], view[i + 1] + view[i + 2]);
        if (fi < cap) fields[fi] = v; else fields.push(v);
        fi++;
        lastQuoted = view[i + 3];
        i += 4;
      } else if (tag === 2) { // SEG
        const s = view[i + 1];
        const l = view[i + 2];
        if (segState === 0) { pStart = s; pLen = l; segState = 1; }
        else if (segState === 1) { parts = [text.slice(pStart, pStart + pLen), text.slice(s, s + l)]; segState = 2; }
        else parts.push(text.slice(s, s + l));
        i += 3;
      } else if (tag === 4) { // FIELD_END
        const v = segState === 0 ? '' : segState === 1 ? text.slice(pStart, pStart + pLen) : parts.join('');
        if (fi < cap) fields[fi] = v; else fields.push(v);
        fi++;
        lastQuoted = view[i + 1];
        segState = 0;
        parts = null;
        i += 2;
      } else if (tag === 3) { // LIT
        const ch = view[i + 1] === 34 ? '"' : '\n';
        if (segState === 0) { parts = [ch]; segState = 2; }
        else if (segState === 1) { parts = [text.slice(pStart, pStart + pLen), ch]; segState = 2; }
        else parts.push(ch);
        i += 2;
      } else { // ERROR (5)
        errors.push({ code: ERR_CODES[view[i + 1]], line: curLine, row: curRow });
        i += 2;
      }
    }
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

let wasmFailed = false;
export function run(input) {
  if (!wasmFailed && wasmScan !== null && typeof Buffer !== 'undefined') {
    try {
      return runWasm(input);
    } catch (e) {
      wasmFailed = true;
    }
  }
  return runJS(input);
}
