import { isharesAdapter } from './ishares.ts';
import type { EtfIssuerAdapter, IssuerAllocationResult, IssuerLookupContext } from './types.ts';

export type {
    AllocationWeightEntry,
    EtfIssuerAdapter,
    IssuerAllocationResult,
    IssuerLookupContext,
} from './types.ts';
export { isharesAdapter } from './ishares.ts';

const REGISTERED_ISSUER_ADAPTERS: EtfIssuerAdapter[] = [
    isharesAdapter,
];

const inFlightLookups = new Map<string, Promise<IssuerAllocationResult | null>>();

async function executeAdapterChain(
    ctx: IssuerLookupContext,
    adapters: EtfIssuerAdapter[]
): Promise<IssuerAllocationResult | null> {
    for (const adapter of adapters) {
        if (!adapter.canHandle(ctx)) {
            continue;
        }

        try {
            const result = await adapter.fetchAllocations(ctx);
            if (result && result.countryAllocations.length > 0) {
                return result;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const diag = `[IssuerAdapter:${adapter.id}] Failed to resolve ${ctx.symbol}: ${msg}`;
            console.warn(diag);
            ctx.onDiagnostic?.(diag);
        }
    }

    return null;
}

/**
 * Attempts to resolve underlying ETF geographic/sector allocations from registered
 * direct-issuer adapters. Coalesces concurrent requests per symbol and fails soft (`null`)
 * so quote fetches never break if an issuer endpoint is unreachable or does not cover the asset.
 */
export async function resolveIssuerAllocations(
    ctx: IssuerLookupContext,
    adapters: EtfIssuerAdapter[] = REGISTERED_ISSUER_ADAPTERS
): Promise<IssuerAllocationResult | null> {
    if (adapters !== REGISTERED_ISSUER_ADAPTERS || ctx.fetchFn) {
        return executeAdapterChain(ctx, adapters);
    }

    const key = `${ctx.symbol.trim().toUpperCase()}|${ctx.fundName?.trim().toLowerCase() ?? ''}`;
    const existing = inFlightLookups.get(key);
    if (existing) {
        return existing;
    }

    const promise = executeAdapterChain(ctx, adapters).finally(() => {
        inFlightLookups.delete(key);
    });
    inFlightLookups.set(key, promise);
    return promise;
}
