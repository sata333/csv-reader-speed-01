import { performance } from 'node:perf_hooks';
import { readCsv as officialReadCsv } from '../vendor/csv-reader/index.js';
import { run as customRun } from '../solve.js';

// 多彩な行パターンを持つ大規模CSVデータを生成
function generateBenchmarkCsv(rowCount = 50000) {
  const lines = ['id,name,description,amount,status'];
  for (let i = 0; i < rowCount; i++) {
    const mod = i % 10;
    if (mod === 0) {
      // 通常
      lines.push(`${i},Item_${i},Simple description without quotes,${i * 1.5},active`);
    } else if (mod === 1) {
      // クォート付き（エスケープあり）
      lines.push(`${i},"Item ""${i}""","Description with ""quotes"" and symbols",${i * 2.5},pending`);
    } else if (mod === 2) {
      // クォート内改行
      lines.push(`${i},"Multi\nline\r\nItem",Detailed multi-line\rnotes,${i},done`);
    } else if (mod === 3) {
      // 孤立CR
      lines.push(`${i},Item\r${i},Stray CR inside unquoted field,${i},active`);
    } else if (mod === 4) {
      // 短い行（short_row）
      lines.push(`${i},Item_${i},Short row`);
    } else if (mod === 5) {
      // 長い行（long_row）
      lines.push(`${i},Item_${i},Long row,100,active,extra1,extra2`);
    } else if (mod === 6) {
      // クォートゴミ（quote_junk）
      lines.push(`${i},"Item_${i}"junk,Quote junk here,${i},active`);
    } else {
      lines.push(`${i},Product_${i},"Standard quoted description, comma included",${i * 3.14},archived`);
    }
  }
  return lines.join('\n');
}

console.log('Generating benchmark dataset (~50,000 rows)...');
const csvText = generateBenchmarkCsv(50000);
const byteSize = Buffer.byteLength(csvText, 'utf8');
console.log(`Generated dataset: ${(byteSize / (1024 * 1024)).toFixed(2)} MB (${csvText.length} characters)`);

const input = { text: csvText, header: true };

// Warmup
console.log('\nWarming up JIT...');
officialReadCsv({ text: 'a,b\n1,2', header: true });
customRun({ text: 'a,b\n1,2', header: true });

// Benchmark Official
console.log('Running official csv-reader 1.0.0...');
const t0 = performance.now();
const officialResult = officialReadCsv(input);
const t1 = performance.now();
const officialTime = t1 - t0;
console.log(`Official csv-reader: ${officialTime.toFixed(2)} ms`);

// Benchmark Custom
console.log('Running custom solve.js...');
const t2 = performance.now();
const customResult = customRun(input);
const t3 = performance.now();
const customTime = t3 - t2;
console.log(`Custom solve.js:     ${customTime.toFixed(2)} ms`);

// Verification
const match = JSON.stringify(officialResult) === JSON.stringify(customResult);
console.log(`\nResults match: ${match ? '✅ EXACT MATCH' : '❌ MISMATCH'}`);

const speedup = officialTime / customTime;
console.log(`Speedup: ${speedup.toFixed(2)}x ${speedup > 1 ? 'FASTER 🚀' : 'SLOWER ⚠️'}`);
