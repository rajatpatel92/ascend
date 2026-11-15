export const ACTIVE_QUANTITY_EPSILON = 0.00001;

/**
 * Builds a complete activity-type-to-behavior map with standard defaults.
 */
export function buildBehaviorMap(activityTypes: Array<{ name: string; behavior: string }> = []): Map<string, string> {
    const behaviorMap = new Map<string, string>();
    for (const t of activityTypes) {
        behaviorMap.set(t.name, t.behavior);
    }

    if (!behaviorMap.has('BUY')) behaviorMap.set('BUY', 'ADD');
    if (!behaviorMap.has('DRIP')) behaviorMap.set('DRIP', 'ADD');
    if (!behaviorMap.has('SELL')) behaviorMap.set('SELL', 'REMOVE');
    if (!behaviorMap.has('DIVIDEND')) behaviorMap.set('DIVIDEND', 'NEUTRAL');
    if (!behaviorMap.has('STOCK_SPLIT')) behaviorMap.set('STOCK_SPLIT', 'SPLIT');
    if (!behaviorMap.has('SPLIT')) behaviorMap.set('SPLIT', 'SPLIT');
    if (!behaviorMap.has('TRANSFER_IN')) behaviorMap.set('TRANSFER_IN', 'ADD');
    if (!behaviorMap.has('TRANSFER_OUT')) behaviorMap.set('TRANSFER_OUT', 'REMOVE');

    return behaviorMap;
}
