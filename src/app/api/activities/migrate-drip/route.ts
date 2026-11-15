import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import { scanDripCandidates } from '@/lib/drip-migration';

export async function GET(req: NextRequest) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const activities = await prisma.activity.findMany({
            where: {
                type: { in: ['DIVIDEND', 'BUY', 'DRIP'] }
            },
            orderBy: { date: 'desc' },
            include: {
                investment: { select: { symbol: true, name: true } },
                account: { select: { name: true, type: true } },
                platform: { select: { name: true } }
            }
        });

        const result = scanDripCandidates(activities);
        return NextResponse.json(result);
    } catch (error) {
        console.error('DRIP migration scan failed:', error);
        return NextResponse.json({ error: 'Failed to scan activities for DRIP matches.' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const body = await req.json();
        const rawIds: unknown = body?.ids;

        if (!Array.isArray(rawIds) || rawIds.length === 0) {
            return NextResponse.json({ error: 'Please select at least one activity to migrate.' }, { status: 400 });
        }

        const ids = Array.from(
            new Set(
                rawIds
                    .filter((id): id is string => typeof id === 'string')
                    .map((id) => id.trim())
                    .filter(Boolean)
            )
        );

        if (ids.length === 0) {
            return NextResponse.json({ error: 'No valid activity IDs provided.' }, { status: 400 });
        }

        const updatedCount = await prisma.$transaction(async (tx) => {
            await tx.activityType.upsert({
                where: { name: 'DRIP' },
                update: {},
                create: { name: 'DRIP', behavior: 'ADD', isSystem: true }
            });

            // Guard with type: 'BUY' so only BUY rows can ever be migrated by this endpoint.
            const res = await tx.activity.updateMany({
                where: {
                    id: { in: ids },
                    type: 'BUY'
                },
                data: { type: 'DRIP' }
            });

            return res.count;
        });

        return NextResponse.json({
            success: true,
            updatedCount
        });
    } catch (error) {
        console.error('DRIP migration update failed:', error);
        return NextResponse.json({ error: 'Failed to migrate selected activities to DRIP.' }, { status: 500 });
    }
}
