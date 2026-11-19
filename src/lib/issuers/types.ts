export type AllocationWeightEntry = { [category: string]: number };

export interface IssuerLookupContext {
    symbol: string;
    fundName?: string | null;
    quoteType?: string | null;
    currency?: string | null;
    fetchFn?: typeof fetch;
    nodeHttpFn?: (
        url: string,
        options: {
            method?: 'GET' | 'POST';
            body?: string;
            headers?: Record<string, string>;
            timeoutMs?: number;
            connectTimeoutMs?: number;
            family?: 0 | 4 | 6;
        }
    ) => Promise<Response>;
    timeoutMs?: number;
    onDiagnostic?: (message: string) => void;
}

export interface IssuerAllocationResult {
    providerId: string;
    productId?: string;
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations?: AllocationWeightEntry[];
    holdingsCount: number;
    asOfDate?: string;
}

export interface EtfIssuerAdapter {
    readonly id: string;
    canHandle(ctx: IssuerLookupContext): boolean;
    fetchAllocations(ctx: IssuerLookupContext): Promise<IssuerAllocationResult | null>;
}
