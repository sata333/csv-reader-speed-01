# csv-reader, read faster

An entry for make.fun's **csv-reader-speed-01-run-20261121** ("Read broken CSV files faster, 21 November
2026"): a drop-in replacement for make.fun's csv-reader 1.0.0 that returns exactly csv-reader's answer for
every input — `{columns, rows, errors}` under the same broken-row policy — in about half the CPU time.

## Files

- `solve.js` — a dependency-free ES module exporting `run(input)`. For `{text, header}` it returns
  csv-reader 1.0.0's reading: the header (or null), every other record as an array of strings at the first
  record's width, and every error met, in order.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`): reads every case from `/input/cases.json`
  (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override), answers each with `run`, writes
  `/output/answers.json`. It sets V8's `--no-incremental-marking` before importing solve.js, as the house
  baseline does.

## How it works

The reference reads one character at a time and builds each field a character at a time. This entry moves
the scanning into WebAssembly and keeps the materialization in JavaScript, where `slice` on the original
string is the cheapest way to build a field:

- **Copy-in.** `run` writes the input text once into WASM linear memory as UTF-16 code units, using
  `Buffer`'s native `utf16le` write straight into a view over that memory (~0.1 µs per KB, and it
  preserves lone surrogates exactly — nothing is ever transcoded through UTF-8).
- **WASM scanner.** A hand-written WAT module (1,568 bytes, embedded in `solve.js` as base64, compiled
  and instantiated once at import) walks the code units once. It is a scalar state machine that mirrors
  csv-reader's broken-input recovery exactly — stray CRs dropped with `stray_cr`, CRs inside quotes
  read as LF, doubled quotes unescaped, junk after a closing quote kept with `quote_junk`, and a quote
  that never closes re-read as an unquoted field with `unterminated_quote` — with a SWAR block skip
  that only fast-forwards over code units provably free of the comma/CR/LF/quote specials and never
  computes quote state itself. Instead of values, it writes a compact descriptor stream: record
  markers with line numbers, field segments, literal characters, and errors in encounter order.
- **JS consumer.** One pass over the stream slices the original string into the answer. A field that is
  a single clean segment — quoted or not, escapes included by construction — is one `slice` behind a
  packed two-word descriptor; only fields the policy forces edits on are assembled from pieces, joined
  once. Data rows are preallocated to the first record's width and filled by index assignment.
- Width padding/cutting (`short_row` with `fields`, `long_row` with `extra`), blank-line skipping, the
  stray-CR-only line that is no record, BOM dropping, and every error's `{code, line, row}` shape and
  order match the reference exactly, including its property order.
- **Fallback.** The previous all-JS implementation (described in the sections below) is kept in the
  same file: if WebAssembly or `Buffer` is unavailable, or the WASM call ever traps, `run` uses it
  instead. Both paths return identical results.

Nothing is kept from one call to the next: `run` is pure and self-contained per case.

## Practice-set results

Against the kit's practice instance (6 cases, ~10.2 MB of CSV):

- **Correctness:** `answers.json` deep-compared with `practice/reference/expected.json` — **all 6 cases
  identical**, including a strict JSON string comparison (same key order).
- **Speed:** process CPU time (user + sys) of the whole `node main.ts` run, median of 7 runs on this
  machine (Node 24 locally; the harness runs Node 22):

  | program | min | median |
  | --- | --- | --- |
  | csv-reader 1.0.0 (house baseline) | 1.666 s | 1.785 s |
  | this entry | 0.804 s | 0.911 s |

  About **2.0× faster** than the baseline end to end; the `run()` phase alone profiles at roughly
  3.5–4× the reference's reading speed, the rest of the run being the JSON input/output both programs
  share.

## Worst-case fix (this version)

The first submitted version gated the whole-record fast path with a fresh `text.indexOf('"', pos)` and
`text.indexOf('\r', pos)` on every record. When the character is absent, `indexOf` scans to the end of
the text, so on quote-free (or CR-free) data the reading was quadratic in the input size — invisible on
the practice set, where quotes are dense, but a clean 9 MB file took ~41 s of CPU. The gate now uses
cached next-quote / next-CR positions (`nextQ` / `nextR`), each recomputed only once the scan position
passes it, so every region of the text is scanned a bounded number of times and reading is linear in
the worst case too.

Semantics are unchanged: the practice answers above still match the reference exactly, the outputs on
every set below are byte-identical to the previous version's, and 3,000 randomized broken inputs
(quotes, stray CRs, CRLF/LF mixes, unterminated quotes, BOMs) agree with the previous version under
both header modes.

Process CPU time (user + sys) of the whole `node main.ts` run, median of 7 interleaved runs on this
machine, min in parentheses:

| set | previous version | this version |
| --- | --- | --- |
| practice set (6 cases, ~10.2 MB) | 0.905 s (0.810) | 0.908 s (0.823) |
| clean, quote-free, 50k rows / 2.2 MB, single case | 2.234 s (2.208) | 0.255 s (0.240) |
| clean, quote-free, 200k rows / 9.0 MB, single case | 40.973 s (39.912) | 0.502 s (0.459) |
| mixed, a quoted field every ~50 records, 5.0 MB, single case | 6.236 s (6.124) | 0.380 s (0.366) |

`run()` alone on the clean sets drops from ~2.09 s (50k rows, single cold run) and ~40 s (200k rows,
the whole-run figure above is almost all `run()`) to a warm median of ~18 ms / ~220 ms (min 12 ms /
51 ms) — linear, the same order as a purpose-built linear scanner.

## WASM scanning offload (this version)

The all-JS reader above is now the fallback; the primary path is the WASM scanner described under
"How it works". Semantics are unchanged: the practice answers still match the reference exactly
(`answers.json` byte-identical to the JS version's), and 44,960 randomized broken inputs (lone
surrogates, mid-text BOM, NUL, unterminated quotes, quote junk, stray CRs, CRLF mixes, empty lines,
short and long rows) agree with the reference under both header modes, error objects compared
byte-for-byte including key order.

Measured on this machine, interleaved runs against the JS version:

| measure | JS version | WASM version |
| --- | --- | --- |
| practice set, whole `node main.ts` run, wall median of 7 | 0.746 s | 0.596 s |
| practice set, whole run, process CPU (user + sys) median of 7 | 0.901 s | 0.704 s |
| practice set, `run()` only, median of 25 | 95.7 ms | 79.9 ms |

`run()`-only medians on adversarial shapes (single-case inputs; the WASM path is faster on each):

| set | JS version | WASM version |
| --- | --- | --- |
| clean, 200k rows / 10.2 MB | 150 ms | 139 ms |
| quote-sparse (~1 quoted field per 50 records) / 9.4 MB | 73 ms | 66 ms |
| quote-dense (escapes, embedded CRLF) / 3.7 MB | 44 ms | 42 ms |
| wide, 500 columns × 2,000 rows / 7.3 MB | 225 ms | 218 ms |
| non-ASCII heavy / 1.6 MB | 16 ms | 11 ms |

Cold start: importing `solve.js` (base64 decode, WASM compile and instantiation included) takes
~2 ms, under 1 ms more than the JS-only file.
