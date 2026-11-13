import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBucketEndMs, parseLocalDate } from './date-utils.ts';

describe('date-utils', () => {
    it('parses YYYY, YYYY-MM, and YYYY-MM-DD strings at local noon without UTC rollback', () => {
        const day = parseLocalDate('2026-03-01');
        assert.equal(day.getFullYear(), 2026);
        assert.equal(day.getMonth(), 2);
        assert.equal(day.getDate(), 1);
        assert.equal(day.getHours(), 12);

        const month = parseLocalDate('2026-11');
        assert.equal(month.getFullYear(), 2026);
        assert.equal(month.getMonth(), 10);
        assert.equal(month.getDate(), 1);

        const year = parseLocalDate('2025');
        assert.equal(year.getFullYear(), 2025);
        assert.equal(year.getMonth(), 0);
        assert.equal(year.getDate(), 1);
    });

    it('computes accurate end-of-period timestamps for monthly and yearly flow buckets', () => {
        // Cutoff = Oct 13, 2026 (simulating 1M range on Nov 13, 2026)
        const cutoffMs = new Date(2026, 9, 13, 0, 0, 0).getTime();

        // Monthly bucket "2026-10-01" overlaps Oct 13-31 -> retained
        assert.ok(getBucketEndMs('2026-10-01', 'month') >= cutoffMs);
        // Monthly bucket "2026-09-01" ends Sep 30 -> excluded
        assert.ok(getBucketEndMs('2026-09-01', 'month') < cutoffMs);

        // Yearly bucket "2026-01-01" ends Dec 31, 2026 -> retained on 1M range
        assert.ok(getBucketEndMs('2026-01-01', 'year') >= cutoffMs);
        // Yearly bucket "2025-01-01" ends Dec 31, 2025 -> excluded on 1M range
        assert.ok(getBucketEndMs('2025-01-01', 'year') < cutoffMs);

        // Weekly bucket "2026-10-10" ends Oct 16, 2026 -> retained
        assert.ok(getBucketEndMs('2026-10-10', 'week') >= cutoffMs);
    });
});
