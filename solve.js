// Highly optimized solve.js for csv-reader-speed-01
// Zero object allocations in field scanning, optimized branching & slice

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
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

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
    const fields = [];
    let recordEnded = false;
    let firstFieldQuoted = false;

    // 2. Read fields in row
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
              break; // next field
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
              // Stray CR: drop it
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
        pos++; // skip opening quote
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
              // Closing quote
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
          // Unterminated quote: rollback and read as unquoted starting with literal '"'
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
          // Quoted field closed normally
          let val = parts === null ? text.slice(open + 1, pos - 1) : parts.join('');

          if (pos >= len) {
            recordEnded = true;
          } else {
            const nextCode = text.charCodeAt(pos);
            if (nextCode === 44) { // ','
              pos++;
            } else if (nextCode === 10) { // '\n'
              pos++;
              line++;
              recordEnded = true;
            } else if (nextCode === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { // '\r\n'
              pos += 2;
              line++;
              recordEnded = true;
            } else {
              // Quote junk: characters follow closing quote
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

    // 3. Skip line that held only stray CRs (empty result, not quoted)
    if (fields.length === 1 && fields[0] === '' && !firstFieldQuoted) {
      continue;
    }

    // 4. Width check & padding / trimming
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
