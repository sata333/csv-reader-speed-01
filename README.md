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

The reference reads one character at a time and builds each field a character at a time. This entry scans
the same text once, left to right, but takes each field's value as one slice of the input whenever the
field is clean, assembling from pieces only where the policy forces edits:

- **Unquoted fields** are scanned with `charCodeAt` to the next comma, LF or CR; with no stray CR met, the
  value is a single `slice`. A stray CR (dropped, error `stray_cr`) splits the field into pieces that are
  joined once.
- **Quoted fields** first try a fast path: `indexOf` finds the next quote; if it is the closing quote and
  the value slice holds no CR, the value is that one slice (the LFs inside are counted off the slice for
  the line tally). Doubled quotes or CRs inside send the field down a piece-assembling path; a quote that
  never closes falls back to the reference's re-read-as-unquoted (`unterminated_quote`), and junk after a
  closing quote is appended by the unquoted reader (`quote_junk`, only when something was appended).
- **Whole records** that sit on one physical line whose content holds no quote and no CR are cut directly
  at their commas — no field in them can be quoted and no reading error can arise.
- Width padding/cutting (`short_row` with `fields`, `long_row` with `extra`), blank-line skipping, the
  stray-CR-only line that is no record, BOM dropping, and every error's `{code, line, row}` shape and order
  match the reference exactly, including its property order.

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
