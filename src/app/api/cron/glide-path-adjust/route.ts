import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isValidCronSecret, requireAuth } from '@/lib/api-auth';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

async function runGlidePathAdjustment(options: { dryRun: boolean; forceOneYearStep: boolean }) {
    const targets = await prisma.targetAllocation.findMany({
        where: {
            yearlyDriftAdjustment: { not: null }
        }
    });

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const updated: Array<{
        symbol: string;
        oldTarget: number;
        newTarget: number;
        yearlyDriftAdjustment: number;
        wouldTrigger: boolean;
        nextEligibleDate: string;
    }> = [];
    const updateOperations = [];

    for (const target of targets) {
        const drift = target.yearlyDriftAdjustment || 0;
        if (drift === 0) continue;

        const referenceDate = target.lastAdjustmentDate || target.createdAt;
        const nextEligible = new Date(referenceDate);
        nextEligible.setFullYear(nextEligible.getFullYear() + 1);

        const isDue = referenceDate <= oneYearAgo;
        const shouldApply = options.forceOneYearStep || isDue;
        const newTarget = Math.max(0, Math.round((target.targetPercentage + drift) * 10) / 10);

        if (shouldApply && !options.dryRun) {
            updateOperations.push(
                prisma.targetAllocation.update({
                    where: { id: target.id },
                    data: {
                        targetPercentage: newTarget,
                        lastAdjustmentDate: new Date()
                    }
                })
            );
        }

        if (shouldApply || options.dryRun) {
            updated.push({
                symbol: target.symbol,
                oldTarget: target.targetPercentage,
                newTarget,
                yearlyDriftAdjustment: drift,
                wouldTrigger: shouldApply,
                nextEligibleDate: nextEligible.toISOString().split('T')[0]
            });
        }
    }

    if (!options.dryRun && updateOperations.length > 0) {
        await prisma.$transaction(updateOperations);
    }

    return {
        success: true,
        dryRun: options.dryRun,
        adjustedCount: options.dryRun ? updated.filter((u) => u.wouldTrigger).length : updateOperations.length,
        updated
    };
}

export async function GET(request: Request) {
    const bearerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const headerKey = request.headers.get('x-cron-secret') || bearerToken;
    const session = await auth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isAdmin = (session?.user as any)?.role === 'ADMIN';

    if (!isValidCronSecret(headerKey) && !isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await runGlidePathAdjustment({ dryRun: false, forceOneYearStep: false });
        return NextResponse.json(result);
    } catch (error: unknown) {
        console.error('Glide Path Cron Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const body = (await request.json().catch(() => ({}))) as {
            dryRun?: boolean;
            forceOneYearStep?: boolean;
        };

        const result = await runGlidePathAdjustment({
            dryRun: Boolean(body.dryRun),
            forceOneYearStep: Boolean(body.forceOneYearStep)
        });

        return NextResponse.json(result);
    } catch (error: unknown) {
        console.error('Glide Path Trigger Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
