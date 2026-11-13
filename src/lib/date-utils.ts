/**
 * Parse a YYYY, YYYY-MM, or YYYY-MM-DD date string into a local-noon Date
 * so timezone offsets never shift dates backward or forward a calendar day.
 */
export function parseLocalDate(dateStr: string): Date {
    const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(dateStr.trim());
    if (match) {
        const y = Number(match[1]);
        const m = match[2] ? Number(match[2]) - 1 : 0;
        const d = match[3] ? Number(match[3]) : 1;
        return new Date(y, m, d, 12, 0, 0);
    }
    return new Date(dateStr);
}

/**
 * Return the end-of-period timestamp (local 23:59:59.999) for a date bucket,
 * allowing range filters to retain active month/year buckets whose start date precedes the cutoff.
 */
export function getBucketEndMs(dateStr: string, granularity: 'day' | 'week' | 'month' | 'year'): number {
    const start = parseLocalDate(dateStr);
    const y = start.getFullYear();
    const m = start.getMonth();
    const d = start.getDate();

    switch (granularity) {
        case 'week':
            return new Date(y, m, d + 6, 23, 59, 59, 999).getTime();
        case 'month':
            return new Date(y, m + 1, 0, 23, 59, 59, 999).getTime();
        case 'year':
            return new Date(y, 11, 31, 23, 59, 59, 999).getTime();
        case 'day':
        default:
            return start.getTime();
    }
}
