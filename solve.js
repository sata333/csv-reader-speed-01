// Ultimate v3 solve.js for csv-reader-speed-01
// Flat single-loop state machine + Streaming cache clean-line fast path + Fast-path quote slicing

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Streaming cache for next quote and CR positions
  let nextQ = len > 0 ? text.indexOf('"', pos) : -1;
  let nextCR = len > 0 ? text.indexOf('\r', pos) : -1;

  while (true) {
    // 1. Skip leading empty lines
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { // '\n'
        pos++;
        line++;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { // '\r\n'
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // 2. High-speed Fast Path for completely clean lines
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? len : lf;

    if (nextQ !== -1 && nextQ < pos) nextQ = text.indexOf('"', pos);
    if (nextCR !== -1 && nextCR < pos) nextCR = text.indexOf('\r', pos);

    const hasQuote = nextQ !== -1 && nextQ < lineEnd;
    const isCrlf = nextCR === lineEnd - 1;
    const hasCr = nextCR !== -1 && nextCR < lineEnd && !isCrlf;

    if (!hasQuote && !hasCr) {
      // Clean line: native C++ split!
      const contentEnd = isCrlf ? lineEnd - 1 : lineEnd;
      const lineSlice = text.slice(pos, contentEnd);
      const fields = lineSlice.split(',');
      pos = lf === -1 ? len : lf + 1;
      if (lf !== -1) line++;

      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // 3. Precision Flat State Machine for quotes & complex rows
    const fields = [];
    let recordEnded = false;
    let firstFieldQuoted = false;

    while (!recordEnded) {
      if (pos >= len) {
        fields.push('');
        break;
      }

      const isQuoted = text.charCodeAt(pos) === 34; // '"'
      if (fields.length === 0) firstFieldQuoted = isQuoted;

      if (!isQuoted) {
        // --- Unquoted field ---
        let start = pos;
        let val = '';
        let hasStrayCr = false;

        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c <= 44) {
            if (c === 44) { // ','
              val = hasStrayCr ? (val + text.slice(start, pos)) : text.slice(start, pos);
              pos++;
              break;
            } else if (c === 10) { // '\n'
              val = hasStrayCr ? (val + text.slice(start, pos)) : text.slice(start, pos);
              pos++;
              line++;
              recordEnded = true;
              break;
            } else if (c === 13) { // '\r'
              if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { // '\r\n'
                val = hasStrayCr ? (val + text.slice(start, pos)) : text.slice(start, pos);
                pos += 2;
                line++;
                recordEnded = true;
                break;
              }
              val += text.slice(start, pos);
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              pos++;
              start = pos;
              hasStrayCr = true;
              continue;
            }
          }
          pos++;
        }

        if (pos >= len && !recordEnded) {
          val = hasStrayCr ? (val + text.slice(start, pos)) : text.slice(start, pos);
          recordEnded = true;
        }

        fields.push(val);

      } else {
        // --- Quoted field ---
        const open = pos;
        const openLine = line;

        // Try Fast Path for simple quoted field
        const close = text.indexOf('"', open + 1);
        if (close !== -1 && text.charCodeAt(close + 1) !== 34) {
          const valSlice = text.slice(open + 1, close);
          if (!valSlice.includes('\r')) {
            // Count internal newlines
            let k = -1;
            while ((k = valSlice.indexOf('\n', k + 1)) !== -1) line++;
            pos = close + 1;

            let val = valSlice;
            if (pos >= len) {
              recordEnded = true;
            } else {
              const nextC = text.charCodeAt(pos);
              if (nextC === 44) {
                pos++;
              } else if (nextC === 10) {
                pos++;
                line++;
                recordEnded = true;
              } else if (nextC === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line++;
                recordEnded = true;
              } else {
                // Quote junk
                let junkAdded = 0;
                let start = pos;
                while (pos < len) {
                  const c = text.charCodeAt(pos);
                  if (c <= 44) {
                    if (c === 44) {
                      val += text.slice(start, pos);
                      junkAdded += pos - start;
                      pos++;
                      break;
                    } else if (c === 10) {
                      val += text.slice(start, pos);
                      junkAdded += pos - start;
                      pos++;
                      line++;
                      recordEnded = true;
                      break;
                    } else if (c === 13) {
                      if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
                        val += text.slice(start, pos);
                        junkAdded += pos - start;
                        pos += 2;
                        line++;
                        recordEnded = true;
                        break;
                      }
                      val += text.slice(start, pos);
                      junkAdded += pos - start;
                      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                      pos++;
                      start = pos;
                      continue;
                    }
                  }
                  pos++;
                }
                if (pos >= len && !recordEnded) {
                  val += text.slice(start, pos);
                  junkAdded += pos - start;
                  recordEnded = true;
                }
                if (junkAdded > 0) {
                  errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                }
              }
            }
            fields.push(val);
            continue;
          }
        }

        // Slow Path: complex quoted field
        pos++;
        let start = pos;
        let parts = null;
        let closed = false;

        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c <= 34) {
            if (c === 34) { // '"'
              if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) { // '""'
                const chunk = text.slice(start, pos);
                if (parts === null) parts = [chunk, '"'];
                else { parts.push(chunk, '"'); }
                pos += 2;
                start = pos;
                continue;
              }
              const chunk = text.slice(start, pos);
              if (parts !== null) parts.push(chunk);
              pos++;
              closed = true;
              break;
            } else if (c === 13) { // '\r'
              const chunk = text.slice(start, pos);
              if (parts === null) parts = [chunk, '\n'];
              else { parts.push(chunk, '\n'); }
              line++;
              pos += (pos + 1 < len && text.charCodeAt(pos + 1) === 10) ? 2 : 1;
              start = pos;
              continue;
            } else if (c === 10) { // '\n'
              line++;
            }
          }
          pos++;
        }

        if (!closed) {
          // Unterminated quote
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          
          let start = pos;
          let val = '"';
          let hasStrayCr = false;

          while (pos < len) {
            const c = text.charCodeAt(pos);
            if (c <= 44) {
              if (c === 44) {
                val = hasStrayCr ? (val + text.slice(start, pos)) : (val + text.slice(start, pos));
                pos++;
                break;
              } else if (c === 10) {
                val += text.slice(start, pos);
                pos++;
                line++;
                recordEnded = true;
                break;
              } else if (c === 13) {
                if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
                  val += text.slice(start, pos);
                  pos += 2;
                  line++;
                  recordEnded = true;
                  break;
                }
                val += text.slice(start, pos);
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                pos++;
                start = pos;
                hasStrayCr = true;
                continue;
              }
            }
            pos++;
          }
          if (pos >= len && !recordEnded) {
            val += text.slice(start, pos);
            recordEnded = true;
          }
          fields.push(val);
        } else {
          let val = parts === null ? text.slice(open + 1, pos - 1) : parts.join('');

          if (pos >= len) {
            recordEnded = true;
          } else {
            const nextCode = text.charCodeAt(pos);
            if (nextCode === 44) {
              pos++;
            } else if (nextCode === 10) {
              pos++;
              line++;
              recordEnded = true;
            } else if (nextCode === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line++;
              recordEnded = true;
            } else {
              let junkAdded = 0;
              let start = pos;
              while (pos < len) {
                const c = text.charCodeAt(pos);
                if (c <= 44) {
                  if (c === 44) {
                    val += text.slice(start, pos);
                    junkAdded += pos - start;
                    pos++;
                    break;
                  } else if (c === 10) {
                    val += text.slice(start, pos);
                    junkAdded += pos - start;
                    pos++;
                    line++;
                    recordEnded = true;
                    break;
                  } else if (c === 13) {
                    if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
                      val += text.slice(start, pos);
                      junkAdded += pos - start;
                      pos += 2;
                      line++;
                      recordEnded = true;
                      break;
                    }
                    val += text.slice(start, pos);
                    junkAdded += pos - start;
                    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                    pos++;
                    start = pos;
                    continue;
                  }
                }
                pos++;
              }
              if (pos >= len && !recordEnded) {
                val += text.slice(start, pos);
                junkAdded += pos - start;
                recordEnded = true;
              }
              if (junkAdded > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
          fields.push(val);
        }
      }
    }

    if (fields.length === 1 && fields[0] === '' && !firstFieldQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }

    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
