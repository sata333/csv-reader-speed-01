import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Tune V8 flags: disable incremental marking and expand young generation to minimize GC overhead
setFlagsFromString('--no-incremental-marking --max-semi-space-size=128');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

// JIT Warmup
run({ text: 'warm,up\n1,2', header: true });

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const len = cases.length;
const answers = new Array(len);
for (let i = 0; i < len; i++) {
  answers[i] = run(cases[i].input);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
