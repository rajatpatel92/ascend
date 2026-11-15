import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';

import { buildBehaviorMap, ACTIVE_QUANTITY_EPSILON } from '@/lib/activity-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const { searchParams } = new URL(request.url);
        const symbol = searchParams.get('symbol');

        if (!symbol) {
            return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
        }

        // Fetch all activities for the symbol
        const activities = await prisma.activity.findMany({
            where: {
                investment: {
                    symbol: symbol
                }
            },
            include: {
                investment: true
            },
            orderBy: {
                date: 'asc'
            }
        });

        // Fetch activity types to determine behavior
        const activityTypes = await prisma.activityType.findMany();
        const behaviorMap = buildBehaviorMap(activityTypes);

        const qtyByAccount = new Map<string, number>();
        const appliedSplits = new Set<string>();

        for (const activity of activities) {
            const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
            const absQty = Math.abs(activity.quantity);
            const accKey = activity.accountId || '__unassigned__';

            if (behavior === 'ADD') {
                qtyByAccount.set(accKey, (qtyByAccount.get(accKey) || 0) + absQty);
            } else if (behavior === 'REMOVE') {
                const nextQty = Math.max(0, (qtyByAccount.get(accKey) || 0) - absQty);
                qtyByAccount.set(accKey, nextQty < 1e-9 ? 0 : nextQty);
            } else if (behavior === 'SPLIT' && absQty > 0) {
                const dayKey = activity.date ? new Date(activity.date).toISOString().split('T')[0] : 'no-date';
                if (activity.accountId) {
                    const splitKey = `${dayKey}:${activity.accountId}:${absQty}`;
                    if (!appliedSplits.has(splitKey)) {
                        appliedSplits.add(splitKey);
                        const prev = qtyByAccount.get(activity.accountId) || 0;
                        if (prev > 0) qtyByAccount.set(activity.accountId, prev * absQty);
                    }
                } else if ((qtyByAccount.get('__unassigned__') || 0) > 0) {
                    const splitKey = `${dayKey}:__unassigned__:${absQty}`;
                    if (!appliedSplits.has(splitKey)) {
                        appliedSplits.add(splitKey);
                        qtyByAccount.set('__unassigned__', (qtyByAccount.get('__unassigned__') || 0) * absQty);
                    }
                } else {
                    const splitKey = `${dayKey}:__global__:${absQty}`;
                    if (!appliedSplits.has(splitKey)) {
                        appliedSplits.add(splitKey);
                        for (const [k, q] of qtyByAccount.entries()) {
                            qtyByAccount.set(k, q * absQty);
                        }
                    }
                }
            }
        }

        let quantity = 0;
        for (const q of qtyByAccount.values()) {
            if (q > ACTIVE_QUANTITY_EPSILON) quantity += q;
        }
        if (quantity <= ACTIVE_QUANTITY_EPSILON) {
            quantity = 0;
        }

        return NextResponse.json({ quantity });

    } catch (error) {
        console.error('Error fetching holdings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
