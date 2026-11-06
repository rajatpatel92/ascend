import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isValidCronSecret } from '@/lib/api-auth';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

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
        const targets = await prisma.targetAllocation.findMany({
            where: {
                yearlyDriftAdjustment: { not: null }
            }
        });

        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        const updated = [];
        const updateOperations = [];

        for (const target of targets) {
            // Compare against last adjustment date or creation date
            const referenceDate = target.lastAdjustmentDate || target.createdAt;
            
            if (referenceDate <= oneYearAgo) {
                const newTarget = Math.max(0, target.targetPercentage + (target.yearlyDriftAdjustment || 0));
                
                updateOperations.push(
                    prisma.targetAllocation.update({
                        where: { id: target.id },
                        data: {
                            targetPercentage: newTarget,
                            lastAdjustmentDate: new Date()
                        }
                    })
                );

                updated.push({
                    symbol: target.symbol,
                    oldTarget: target.targetPercentage,
                    newTarget: newTarget
                });
            }
        }

        if (updateOperations.length > 0) {
            await prisma.$transaction(updateOperations);
        }

        return NextResponse.json({
            success: true,
            adjustedCount: updated.length,
            updated
        });
    } catch (error: any) {
        console.error('Glide Path Cron Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
