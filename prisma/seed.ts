import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const adminUsername = 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;

    const existingAdmin = await prisma.user.findUnique({
        where: { username: adminUsername },
    });

    if (!existingAdmin) {
        if (!adminPassword) {
            throw new Error('ADMIN_PASSWORD environment variable is required for initial seeding of the admin user.');
        }
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        await prisma.user.create({
            data: {
                username: adminUsername,
                password: hashedPassword,
                role: 'ADMIN',
            },
        });
        console.log(`Admin user created with username: ${adminUsername}`);
    } else {
        console.log('Admin user already exists.');
    }

    // Seed Exchange Rates
    const rates = [
        { symbol: 'INR=X', price: 89.43, currency: 'INR' }, // Updated symbol and rate
        { symbol: 'CAD=X', price: 1.40, currency: 'CAD' }, // Updated to CAD=X
        { symbol: 'CADUSD=X', price: 0.71, currency: 'USD' },
        { symbol: 'INRUSD=X', price: 0.011, currency: 'USD' }, // Updated approx reverse rate
    ];

    for (const rate of rates) {
        await prisma.marketDataCache.upsert({
            where: { symbol: rate.symbol },
            update: {}, // Don't update if exists, let the app fetch fresh data
            create: {
                symbol: rate.symbol,
                price: rate.price,
                change: 0,
                changePercent: 0,
                currency: rate.currency,
                lastUpdated: new Date(0), // Set as expired so it fetches fresh data immediately
            },
        });
    }
    console.log('Exchange rates seeded.');

    // Seed Yahoo Investment Types
    const yahooTypes = [
        'EQUITY', 'ETF', 'MUTUALFUND', 'CRYPTOCURRENCY', 'FUTURE', 'INDEX', 'OPTION', 'CURRENCY', 'BOND'
    ];

    for (const name of yahooTypes) {
        await prisma.yahooInvestmentType.upsert({
            where: { name },
            update: {},
            create: { name },
        });
    }
    console.log('Yahoo Investment types seeded.');

    // Seed Investment Types and Map to Yahoo Types
    const investmentTypes = [
        { name: 'Stock', yahooType: 'EQUITY' },
        { name: 'ETF', yahooType: 'ETF' },
        { name: 'Mutual Fund', yahooType: 'MUTUALFUND' },
        { name: 'Crypto', yahooType: 'CRYPTOCURRENCY' },
        { name: 'Bond', yahooType: 'BOND' },
        { name: 'GIC', yahooType: null },
        { name: 'REIT', yahooType: 'EQUITY' },
        { name: 'Cash', yahooType: 'CURRENCY' }
    ];

    for (const type of investmentTypes) {
        // Find Yahoo Type ID if applicable
        let yahooTypeId = null;
        if (type.yahooType) {
            const yt = await prisma.yahooInvestmentType.findUnique({ where: { name: type.yahooType } });
            yahooTypeId = yt?.id;
        }

        // Upsert Investment Type
        // We only want to set the yahooInvestmentTypeId if it is NOT set, or if we are creating it.
        // We don't want to overwrite user changes if they changed the mapping.
        const existing = await prisma.investmentType.findUnique({ where: { name: type.name } });

        if (!existing) {
            await prisma.investmentType.create({
                data: {
                    name: type.name,
                    yahooInvestmentTypeId: yahooTypeId
                }
            });
        } else {
            // Optional: If existing but has NO mapping, we could auto-map it?
            // Let's safe-update: Only update if yahooInvestmentTypeId is null and we have a default for it.
            if (existing.yahooInvestmentTypeId === null && yahooTypeId) {
                await prisma.investmentType.update({
                    where: { id: existing.id },
                    data: { yahooInvestmentTypeId: yahooTypeId }
                });
            }
        }
    }
    console.log('Investment types seeded and mapped.');

    // Seed Account Types
    const accountTypes = [
        // Canada
        { name: 'TFSA', currency: 'CAD' },
        { name: 'RRSP', currency: 'CAD' },
        { name: 'FHSA', currency: 'CAD' },
        { name: 'RESP', currency: 'CAD' },
        { name: 'LIRA', currency: 'CAD' },
        { name: 'Non-Registered', currency: 'CAD' },
        { name: 'Margin', currency: 'CAD' },
        // India
        { name: 'Demat', currency: 'INR' },
        { name: 'PPF', currency: 'INR' },
        { name: 'EPF', currency: 'INR' },
        { name: 'NPS', currency: 'INR' },
        { name: 'Savings', currency: 'INR' },
        { name: 'NRE', currency: 'INR' },
        { name: 'NRO', currency: 'INR' },
        // US
        { name: '401(k)', currency: 'USD' },
        { name: 'Roth IRA', currency: 'USD' },
        { name: 'Traditional IRA', currency: 'USD' },
        { name: 'Brokerage', currency: 'USD' },
    ];

    for (const type of accountTypes) {
        await prisma.accountType.upsert({
            where: { name_currency: { name: type.name, currency: type.currency } },
            update: {},
            create: { name: type.name, currency: type.currency },
        });
    }
    console.log('Account types seeded.');

    // Seed Activity Types
    // Seed Activity Types
    const activityTypes = [
        { name: 'BUY', behavior: 'ADD', isSystem: true },
        { name: 'SELL', behavior: 'REMOVE', isSystem: true },
        { name: 'DIVIDEND', behavior: 'NEUTRAL', isSystem: true },
        { name: 'INTEREST', behavior: 'NEUTRAL', isSystem: true },
        { name: 'STOCK_SPLIT', behavior: 'SPLIT', isSystem: true },
        { name: 'DEPOSIT', behavior: 'ADD', isSystem: true },
        { name: 'WITHDRAWAL', behavior: 'REMOVE', isSystem: true },
        { name: 'TRANSFER_IN', behavior: 'ADD', isSystem: true },
        { name: 'TRANSFER_OUT', behavior: 'REMOVE', isSystem: true },
    ];

    for (const type of activityTypes) {
        await prisma.activityType.upsert({
            where: { name: type.name },
            update: { behavior: type.behavior, isSystem: type.isSystem },
            create: { name: type.name, behavior: type.behavior, isSystem: type.isSystem },
        });
    }
    console.log('Activity types seeded.');

    // Seed Benchmarks
    const benchmarks = [
        { symbol: '^GSPC', name: 'S&P 500', isSystem: true },
        { symbol: '^IXIC', name: 'NASDAQ Composite', isSystem: true },
        { symbol: '^GSPTSE', name: 'S&P/TSX Composite', isSystem: true },
        { symbol: 'BTC-USD', name: 'Bitcoin', isSystem: true },
        { symbol: 'XEQT.TO', name: 'iShares Core Equity (XEQT)', isSystem: true },
    ];

    for (const b of benchmarks) {
        await prisma.benchmark.upsert({
            where: { symbol: b.symbol },
            update: {},
            create: b,
        });
    }
    console.log('Benchmarks seeded.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
