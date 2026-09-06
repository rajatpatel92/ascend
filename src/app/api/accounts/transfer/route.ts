import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { sourceAccountId, destinationAccountId } = body;

        if (!sourceAccountId || !destinationAccountId) {
            return NextResponse.json({ error: 'Source and Destination accounts are required' }, { status: 400 });
        }

        if (sourceAccountId === destinationAccountId) {
            return NextResponse.json({ error: 'Source and Destination accounts cannot be the same' }, { status: 400 });
        }

        // 1. Fetch all activities for the source account
        const sourceActivities = await prisma.activity.findMany({
            where: { accountId: sourceAccountId },
            include: { investment: true, platform: true }
        });

        if (sourceActivities.length === 0) {
            return NextResponse.json({ error: 'No holdings found in the source account to transfer' }, { status: 400 });
        }

        // 2. Map activity types to behaviors
        const activityTypes = await prisma.activityType.findMany();
        const behaviorMap = new Map<string, string>();
        activityTypes.forEach(t => behaviorMap.set(t.name, t.behavior));

        if (!behaviorMap.has('BUY')) behaviorMap.set('BUY', 'ADD');
        if (!behaviorMap.has('SELL')) behaviorMap.set('SELL', 'REMOVE');
        if (!behaviorMap.has('TRANSFER_IN')) behaviorMap.set('TRANSFER_IN', 'ADD');
        if (!behaviorMap.has('TRANSFER_OUT')) behaviorMap.set('TRANSFER_OUT', 'REMOVE');
        if (!behaviorMap.has('DIVIDEND')) behaviorMap.set('DIVIDEND', 'NEUTRAL');

        // 3. Calculate holdings and cost basis per investment
        const holdingsMap = new Map<string, { quantity: number; costBasis: number; investmentId: string; currency: string; platformId: string | null }>();

        // Sort activities by date to properly calculate running average/cost basis
        sourceActivities.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        for (const activity of sourceActivities) {
            const symbol = activity.investment.symbol;
            if (!holdingsMap.has(symbol)) {
                holdingsMap.set(symbol, {
                    quantity: 0,
                    costBasis: 0,
                    investmentId: activity.investment.id,
                    currency: activity.currency,
                    platformId: activity.platformId
                });
            }

            const current = holdingsMap.get(symbol)!;
            const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
            const absQty = Math.abs(activity.quantity);
            const amount = absQty * activity.price;
            const fee = activity.fee || 0;

            if (behavior === 'ADD') {
                current.quantity += absQty;
                current.costBasis += (amount + fee);
            } else if (behavior === 'REMOVE') {
                // Adjust cost basis proportionally for removes
                if (current.quantity > 0) {
                    const removeRatio = absQty / current.quantity;
                    current.costBasis -= (current.costBasis * removeRatio);
                }
                current.quantity -= absQty;
            } else if (behavior === 'SPLIT') {
                if (absQty > 0) {
                    current.quantity *= absQty; // Assuming split ratio is represented by quantity
                }
            }
            // NEUTRAL operations like DIVIDEND don't affect cost basis or quantity
        }

        // Fetch destination account to get its platformId so we can correctly set it for TRANSFER_IN
        const destinationAccount = await prisma.account.findUnique({
            where: { id: destinationAccountId }
        });

        if (!destinationAccount) {
            return NextResponse.json({ error: 'Destination account not found' }, { status: 404 });
        }

        // 4. Generate TRANSFER_IN and TRANSFER_OUT activities for positive holdings
        const transferActivitiesToCreate: any[] = [];
        const now = new Date();

        for (const [symbol, holding] of Array.from(holdingsMap.entries())) {
            // Because of floating point math, ensure quantity > a very small epsilon
            if (holding.quantity > 0.000001) {
                const averageCost = holding.quantity > 0 ? (holding.costBasis / holding.quantity) : 0;

                // Transfer Out
                transferActivitiesToCreate.push({
                    investmentId: holding.investmentId,
                    type: 'TRANSFER_OUT',
                    date: now,
                    quantity: holding.quantity,
                    price: averageCost,
                    fee: 0,
                    currency: holding.currency,
                    platformId: holding.platformId,
                    accountId: sourceAccountId
                });

                // Transfer In
                transferActivitiesToCreate.push({
                    investmentId: holding.investmentId,
                    type: 'TRANSFER_IN',
                    date: now,
                    quantity: holding.quantity,
                    price: averageCost,
                    fee: 0,
                    currency: holding.currency,
                    platformId: destinationAccount.platformId,
                    accountId: destinationAccountId
                });
            }
        }

        if (transferActivitiesToCreate.length === 0) {
            return NextResponse.json({ error: 'No positive holdings found to transfer' }, { status: 400 });
        }

        // 5. Save all new activities in a transaction
        await prisma.$transaction(async (tx) => {
            await tx.activity.createMany({
                data: transferActivitiesToCreate
            });

            if (body.deactivateSourceAccount === true) {
                await tx.account.update({
                    where: { id: sourceAccountId },
                    data: { isActive: false }
                });
            }
        });

        return NextResponse.json({ success: true, transferredHoldingsCount: transferActivitiesToCreate.length / 2 });

    } catch (error) {
        console.error('Error transferring accounts:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}