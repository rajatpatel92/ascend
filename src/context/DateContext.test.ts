import test from 'node:test';
import assert from 'node:assert';

function formatDate(date: Date | string | number, dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MMM DD, YYYY'): string {
    if (date === undefined || date === null || date === '') return '';

    let year: number;
    let month: number;
    let day: number;

    if (typeof date === 'string') {
        const trimmed = date.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
            const datePart = trimmed.split('T')[0];
            const parts = datePart.split('-');
            year = parseInt(parts[0], 10);
            month = parseInt(parts[1], 10);
            day = parseInt(parts[2], 10);
        } else {
            const d = new Date(trimmed);
            if (isNaN(d.getTime())) return 'Invalid Date';
            year = d.getFullYear();
            month = d.getMonth() + 1;
            day = d.getDate();
        }
    } else if (date instanceof Date) {
        if (isNaN(date.getTime())) return 'Invalid Date';
        year = date.getFullYear();
        month = date.getMonth() + 1;
        day = date.getDate();
    } else if (typeof date === 'number') {
        const d = new Date(date);
        if (isNaN(d.getTime())) return 'Invalid Date';
        year = d.getFullYear();
        month = d.getMonth() + 1;
        day = d.getDate();
    } else {
        return 'Invalid Date';
    }

    if (isNaN(year) || isNaN(month) || isNaN(day)) return 'Invalid Date';

    const pad = (n: number) => n.toString().padStart(2, '0');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    switch (dateFormat) {
        case 'DD/MM/YYYY':
            return `${pad(day)}/${pad(month)}/${year}`;
        case 'YYYY-MM-DD':
            return `${year}-${pad(month)}-${pad(day)}`;
        case 'MMM DD, YYYY':
            return `${monthNames[month - 1]} ${pad(day)}, ${year}`;
        case 'MM/DD/YYYY':
        default:
            return `${pad(month)}/${pad(day)}/${year}`;
    }
}

test('formatDate - Timezone-safe date formatting', async (t) => {
    await t.test('formats YYYY-MM-DD string without timezone rollback', () => {
        assert.strictEqual(formatDate('2026-08-29', 'MM/DD/YYYY'), '08/29/2026');
        assert.strictEqual(formatDate('2026-08-29', 'DD/MM/YYYY'), '29/08/2026');
        assert.strictEqual(formatDate('2026-08-29', 'YYYY-MM-DD'), '2026-08-29');
        assert.strictEqual(formatDate('2026-08-29', 'MMM DD, YYYY'), 'Aug 29, 2026');
    });

    await t.test('formats ISO UTC timestamp string without timezone rollback', () => {
        assert.strictEqual(formatDate('2026-08-29T00:00:00.000Z', 'MM/DD/YYYY'), '08/29/2026');
        assert.strictEqual(formatDate('2026-08-29T00:00:00.000Z', 'MMM DD, YYYY'), 'Aug 29, 2026');
    });

    await t.test('handles empty / invalid date values cleanly', () => {
        assert.strictEqual(formatDate('', 'MM/DD/YYYY'), '');
        assert.strictEqual(formatDate('invalid-date', 'MM/DD/YYYY'), 'Invalid Date');
    });
});
