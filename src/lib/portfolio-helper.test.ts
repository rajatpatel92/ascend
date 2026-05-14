
import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Calculates holdings from a provided list of activities up to a specific date.
 * Useful for avoiding N+1 queries when activities are already loaded.
 *
 * @param activities List of activities (should be pre-sorted by date asc for correct results)
 * @param date The date to check holdings for (inclusive)
 * @returns A map of accountId -> quantity
 */
function calculateHoldingsFromActivities(activities: any[], date: Date): Record<string, number> {
    const holdings: Record<string, number> = {};

    for (const activity of activities) {
        const activityDate = new Date(activity.date);
        if (activityDate > date) continue;

        const accId = activity.accountId || 'unknown';
        if (!holdings[accId]) holdings[accId] = 0;

        if (activity.type === 'BUY') {
            holdings[accId] += activity.quantity;
        } else if (activity.type === 'SELL') {
            holdings[accId] -= Math.abs(activity.quantity);
        } else if (activity.type === 'SPLIT' || activity.type === 'STOCK_SPLIT') {
            holdings[accId] *= activity.quantity;
        }
    }

    const result: Record<string, number> = {};
    for (const [accId, qty] of Object.entries(holdings)) {
        if (qty > 0) result[accId] = qty;
    }

    return result;
}

test('calculateHoldingsFromActivities', async (t) => {
    await t.test('calculates basic holdings from BUY activities', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: 'acc1' },
            { id: '2', type: 'BUY', quantity: 5, date: new Date('2023-01-02'), accountId: 'acc1' },
            { id: '3', type: 'BUY', quantity: 20, date: new Date('2023-01-01'), accountId: 'acc2' },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['acc1'], 15);
        assert.strictEqual(holdings['acc2'], 20);
    });

    await t.test('handles SELL activities', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: 'acc1' },
            { id: '2', type: 'SELL', quantity: 4, date: new Date('2023-01-02'), accountId: 'acc1' },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['acc1'], 6);
    });

    await t.test('handles STOCK_SPLIT activities', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: 'acc1' },
            { id: '2', type: 'STOCK_SPLIT', quantity: 2, date: new Date('2023-01-02'), accountId: 'acc1' },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['acc1'], 20);
    });

    await t.test('respects the target date', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: 'acc1' },
            { id: '2', type: 'BUY', quantity: 5, date: new Date('2023-01-05'), accountId: 'acc1' },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['acc1'], 10);
    });

    await t.test('filters out zero or negative holdings', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: 'acc1' },
            { id: '2', type: 'SELL', quantity: 10, date: new Date('2023-01-02'), accountId: 'acc1' },
            { id: '3', type: 'BUY', quantity: 5, date: new Date('2023-01-01'), accountId: 'acc2' },
            { id: '4', type: 'SELL', quantity: 10, date: new Date('2023-01-02'), accountId: 'acc2' },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['acc1'], undefined);
        assert.strictEqual(holdings['acc2'], undefined);
    });

    await t.test('handles unknown accountId', () => {
        const activities = [
            { id: '1', type: 'BUY', quantity: 10, date: new Date('2023-01-01'), accountId: null },
        ];
        const date = new Date('2023-01-03');
        const holdings = calculateHoldingsFromActivities(activities, date);

        assert.strictEqual(holdings['unknown'], 10);
    });
});
