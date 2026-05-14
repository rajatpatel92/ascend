import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import Papa from 'papaparse';
import { MarketDataService } from '@/lib/market-data';
import { auth } from '@/auth';

const REQUIRED_FIELDS = ['Date', 'Type', 'Symbol', 'Quantity', 'Price', 'Username', 'Account Type', 'Platform'];

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { csvContent } = body;

        if (!csvContent) {
            return NextResponse.json({ error: 'No CSV content provided' }, { status: 400 });
        }

        // Parse CSV
        const parseResult = Papa.parse(csvContent, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (h) => h.trim() // Handle potential whitespace in headers
        });

        if (parseResult.errors.length > 0) {
            return NextResponse.json({
                valid: false,
                errors: parseResult.errors.map(e => ({ row: e.row, message: e.message }))
            }, { status: 400 });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = parseResult.data as any[];
        const errors: { row: number, message: string }[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const validRows: any[] = [];

        // Fetch reference data for validation
        const accounts = await prisma.account.findMany();
        const platforms = await prisma.platform.findMany();

        // Create lookup maps
        // Map "name|type" -> Account[] because different platforms might have same account name/type
        const accountMap = new Map<string, typeof accounts>();
        accounts.forEach(a => {
            const key = `${a.name.toLowerCase()}|${a.type.toLowerCase()}`;
            const existing = accountMap.get(key) || [];
            existing.push(a);
            accountMap.set(key, existing);
        });

        const platformMap = new Map(platforms.map(p => [p.name.toLowerCase(), p]));

        // Validate Symbols
        const uniqueSymbols = Array.from(new Set(rows.map(r => r.Symbol?.toString().trim()).filter(s => s)));
        const invalidSymbols = new Set<string>();

        await Promise.all(uniqueSymbols.map(async (symbol) => {
            const data = await MarketDataService.getPrice(symbol);
            if (!data) {
                invalidSymbols.add(symbol);
            }
        }));

        // Validate each row
        rows.forEach((row, index) => {
            const rowNum = index + 1;
            const rowErrors: string[] = [];

            // Check required fields
            for (const field of REQUIRED_FIELDS) {
                if (!row[field] || row[field].toString().trim() === '') {
                    rowErrors.push(`Missing required field: ${field}`);
                }
            }

            if (rowErrors.length > 0) {
                errors.push({ row: rowNum, message: rowErrors.join(', ') });
                return;
            }

            // Validate Symbol
            const symbol = row['Symbol'].trim();
            if (invalidSymbols.has(symbol)) {
                rowErrors.push(`Symbol '${symbol}' might be invalid or delisted`);
            }

            // Validate Date
            const date = new Date(row['Date']);
            if (isNaN(date.getTime())) {
                rowErrors.push(`Invalid Date format: ${row['Date']}`);
            }

            // Validate Numbers
            const quantity = parseFloat(row['Quantity']);
            const price = parseFloat(row['Price']);
            const fee = row['Fee'] ? parseFloat(row['Fee']) : 0;

            if (isNaN(quantity)) rowErrors.push(`Invalid Quantity: ${row['Quantity']}`);
            if (isNaN(price)) rowErrors.push(`Invalid Price: ${row['Price']}`);
            if (row['Fee'] && isNaN(fee)) rowErrors.push(`Invalid Fee: ${row['Fee']}`);

            // Validate Platform FIRST
            const platformName = row['Platform'].trim();
            const platform = platformMap.get(platformName.toLowerCase());
            if (!platform) {
                rowErrors.push(`Platform not found: ${platformName}`);
            }

            // Validate Account (Name + Type) AND match with Platform
            const accountName = row['Username'].trim();
            const accountType = row['Account Type'].trim();
            const accountKey = `${accountName.toLowerCase()}|${accountType.toLowerCase()}`;

            const prospectiveAccounts = accountMap.get(accountKey);
            let account: typeof accounts[0] | undefined;

            if (!prospectiveAccounts || prospectiveAccounts.length === 0) {
                rowErrors.push(`Account/User not found: ${accountName} (${accountType})`);
            } else if (platform) {
                // Find the account that belongs to this platform
                account = prospectiveAccounts.find(a => a.platformId === platform.id);

                if (!account) {
                    // Found accounts with this name/type, but none linked to the specified platform
                    rowErrors.push(`Account '${accountName} - ${accountType}' exists but is not linked to platform '${platform.name}'`);
                }
            }

            if (rowErrors.length > 0) {
                errors.push({ row: rowNum, message: rowErrors.join('; ') });
            } else {
                validRows.push({
                    ...row,
                    accountId: account!.id,
                    platformId: platform!.id,
                    parsedDate: date,
                    parsedQuantity: quantity,
                    parsedPrice: price,
                    parsedFee: fee
                });
            }
        });

        return NextResponse.json({
            valid: errors.length === 0,
            errors,
            data: validRows,
            totalRows: rows.length
        });

    } catch (error) {
        console.error('Validation error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
