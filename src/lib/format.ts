
/**
 * Formats a quantity number to a string with a maximum of 4 decimal places.
 * Used for shares/units display across the application.
 */
export function formatQuantity(quantity: number | undefined | null): string {
    if (quantity === undefined || quantity === null || !Number.isFinite(quantity)) return '-';
    const safeQuantity = Math.abs(quantity) < 0.00005 ? 0 : quantity;
    // Use standard locale formatting, limit to 4 decimals
    // If integer, shows no decimals. If 1.123456, shows 1.1235
    return safeQuantity.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4
    });
}
