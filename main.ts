// The driver the harness runs (`node /bot/main.ts`, Node 22): reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one, and writes /output/answers.json: a JSON array of the answers, one
// per case and in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// Fast path: when solve.js's runJson is available, each case's answer JSON is produced inside WASM
// (scan + serialize) and written out raw; any case that cannot take the fast path falls the whole
// file back to run() + JSON.stringify, so the output bytes are the same either way.

import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run, runJson } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  runJson?: (input: unknown) => { rows: Uint8Array; errs: Uint8Array } | null;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

let fast = typeof runJson === 'function';
if (fast) {
  const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
  try {
    writeSync(fd, '[');
    let first = true;
    for (const c of cases) {
      const r = runJson!(c.input);
      if (r === null) { fast = false; break; }
      if (!first) writeSync(fd, ',');
      first = false;
      writeSync(fd, '{');
      writeSync(fd, r.rows);
      writeSync(fd, ',');
      writeSync(fd, r.errs);
      writeSync(fd, '}');
    }
    if (fast) writeSync(fd, ']');
  } finally {
    closeSync(fd);
  }
}
if (!fast) {
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}
