/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const body = await req.json();
        const { ids, updates } = body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return NextResponse.json({ error: 'No IDs provided' }, { status: 400 });
        }

        if (!updates || Object.keys(updates).length === 0) {
            return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
        }

        // Prepare Activity updates
        const activityUpdates: any = {};
        if (updates.accountId) activityUpdates.accountId = updates.accountId;
        if (updates.platformId) activityUpdates.platformId = updates.platformId;
        if (updates.type) activityUpdates.type = updates.type;

        // Transaction to handle everything atomic
        await prisma.$transaction(async (tx) => {
            // 1. Update Activities
            if (Object.keys(activityUpdates).length > 0) {
                await tx.activity.updateMany({
                    where: { id: { in: ids } },
                    data: activityUpdates
                });
            }

            // 2. Update Investment Type if requested
            // This is trickier because we need to find the specific investments associated with these activities
            if (updates.investmentType) {
                // Find all unique investmentIds for these activities
                const activities = await tx.activity.findMany({
                    where: { id: { in: ids } },
                    select: { investmentId: true }
                });

                const investmentIds = Array.from(new Set(activities.map(a => a.investmentId)));

                if (investmentIds.length > 0) {
                    await tx.investment.updateMany({
                        where: { id: { in: investmentIds } },
                        data: { type: updates.investmentType }
                    });
                }
            }
        });

        return NextResponse.json({ success: true, count: ids.length });

    } catch (error) {
        console.error('Batch update failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
