import test from 'node:test';
import assert from 'node:assert';
import { calculateXIRR } from './xirr.ts';

interface Transaction {
    amount: number;
    date: Date;
}

test('calculateXIRR', async (t) => {
  await t.test('returns null for empty transactions array', () => {
    assert.strictEqual(calculateXIRR([]), null);
  });

  await t.test('returns null for transactions array with 1 item', () => {
    const transactions: Transaction[] = [
      { amount: -1000, date: new Date('2023-01-01') }
    ];
    assert.strictEqual(calculateXIRR(transactions as any), null);
  });

  await t.test('calculates correct XIRR for simple case (10% return)', () => {
    const transactions: Transaction[] = [
      { amount: -1000, date: new Date('2023-01-01') },
      { amount: 1100, date: new Date('2024-01-01') }
    ];
    const result = calculateXIRR(transactions as any);
    assert.ok(result !== null);
    // 10% return over exactly one year should be 0.1
    assert.ok(Math.abs(result! - 0.1) < 1e-6);
  });

  await t.test('does not mutate caller array order and converges for deep losses (-90%)', () => {
    const txs: Transaction[] = [
      { amount: 100, date: new Date('2024-01-01') },
      { amount: -1000, date: new Date('2023-01-01') }
    ];
    const originalFirstDate = txs[0].date.getTime();
    const result = calculateXIRR(txs as any);
    assert.strictEqual(txs[0].date.getTime(), originalFirstDate);
    assert.ok(result !== null);
    assert.ok(Math.abs(result! - (-0.9)) < 1e-5, `Expected -0.9, got ${result}`);
  });

  await t.test('returns null for same-day flows or single-sign flows', () => {
    assert.strictEqual(calculateXIRR([
      { amount: -500, date: new Date('2024-01-01') },
      { amount: 600, date: new Date('2024-01-01') }
    ] as any), null);

    assert.strictEqual(calculateXIRR([
      { amount: -500, date: new Date('2023-01-01') },
      { amount: -500, date: new Date('2024-01-01') }
    ] as any), null);
  });
});
