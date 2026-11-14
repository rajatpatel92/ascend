export interface SelectableAccount {
    id: string;
    name: string;
    type: string;
    platformId: string;
    currency: string;
    isActive?: boolean;
}

/**
 * Filters accounts shown in the activity form's Account dropdown.
 * - For new activities (no editingAccountId): only active accounts matching the currency are included.
 * - When editing an existing activity: active accounts matching the currency are included,
 *   and the activity's own account is never excluded (even if inactive/transferred out).
 */
export function filterSelectableAccounts<T extends SelectableAccount>(
    accounts: T[],
    currency: string,
    editingAccountId?: string | null
): T[] {
    return accounts.filter(
        (account) =>
            (account.currency === currency && account.isActive !== false) ||
            (Boolean(editingAccountId) && account.id === editingAccountId)
    );
}
