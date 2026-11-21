import assert from 'node:assert/strict';
import { readCsv as officialReadCsv } from '../vendor/csv-reader/index.js';
import { run as customRun } from '../solve.js';

const testCases = [
  // 1. 基本
  { name: 'Simple 2x2', input: { text: 'a,b\n1,2', header: true } },
  { name: 'Simple without header', input: { text: 'a,b\n1,2', header: false } },
  { name: 'Empty string header=true', input: { text: '', header: true } },
  { name: 'Empty string header=false', input: { text: '', header: false } },
  { name: 'Single field', input: { text: 'hello', header: false } },
  { name: 'BOM at start', input: { text: '\uFEFFcol1,col2\nval1,val2', header: true } },
  { name: 'Trailing newline', input: { text: 'a,b\n1,2\n', header: true } },
  { name: 'Multiple empty lines', input: { text: '\n\na,b\n\n1,2\n\n', header: true } },
  { name: 'CRLF line endings', input: { text: "a,b\r\n1,2\r\n3,4\r\n", header: true } },

  // 2. 壊れた行・CR
  { name: 'Stray CR outside quotes', input: { text: "a\rb,c\n1,2", header: true } },
  { name: 'Line with only stray CR', input: { text: "a,b\n\r\r\n1,2", header: true } },

  // 3. クォート & エスケープ
  { name: 'Simple quoted field', input: { text: '"hello","world"\n"foo","bar"', header: true } },
  { name: 'Escaped quotes inside quote', input: { text: '"he""llo","wo""rld"', header: false } },
  { name: 'Newline inside quote (LF)', input: { text: '"line1\nline2",val\n1,2', header: true } },
  { name: 'Newline inside quote (CRLF)', input: { text: '"line1\r\nline2",val\n1,2', header: true } },
  { name: 'Newline inside quote (lone CR)', input: { text: '"line1\rline2",val\n1,2', header: true } },
  { name: 'Quote inside unquoted field (treated literal)', input: { text: 'a"b,c\n1,2', header: true } },

  // 4. 壊れたクォート (unterminated & quote_junk)
  { name: 'Unterminated quote', input: { text: '"hello,world\n1,2', header: true } },
  { name: 'Unterminated quote with newline', input: { text: '"hello\nworld', header: false } },
  { name: 'Quote junk', input: { text: '"hello"junk,world\n1,2', header: true } },
  { name: 'Quote junk with escape', input: { text: '"he""llo"extra,world', header: false } },

  // 5. 幅の不一致 (short_row & long_row)
  { name: 'Short row', input: { text: 'a,b,c\n1,2\n3,4,5', header: true } },
  { name: 'Long row', input: { text: 'a,b\n1,2,3,4\n5,6', header: true } },
  { name: 'Short and long rows mixed', input: { text: 'a,b,c\n1\n2,3,4,5\n6,7,8', header: true } },
  { name: 'Header short/long', input: { text: 'a\n1,2,3', header: true } },

  // 6. 複雑な組み合わせ
  {
    name: 'Complex broken combinations',
    input: {
      text: '\uFEFF"col\r1",col2,"col""3"""junk\r\n' +
            'val1,"val\n2\r\n3",val4\r\n' +
            '\r\n' +
            'short1\n' +
            'long1,long2,long3,long4\r\n' +
            '"never ending quote\nline continues,still here',
      header: true
    }
  }
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const expected = officialReadCsv(tc.input);
  const actual = customRun(tc.input);
  
  const expectedStr = JSON.stringify(expected);
  const actualStr = JSON.stringify(actual);

  if (expectedStr === actualStr) {
    passed++;
  } else {
    failed++;
    console.error(`❌ FAILED: ${tc.name}`);
    console.error('Expected:', expectedStr);
    console.error('Actual:  ', actualStr);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${testCases.length} tests.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All verification tests PASSED!');
}
