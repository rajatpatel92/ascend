import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
    try {
        const targets = await prisma.targetAllocation.findMany({
            orderBy: { symbol: 'asc' }
        });
        return NextResponse.json({ targets });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { targets } = body;

        if (!Array.isArray(targets)) {
            return NextResponse.json({ error: 'targets must be an array' }, { status: 400 });
        }

        const inputSymbols = targets.map((t: any) => t.symbol);

        // Delete targets that are no longer in the payload
        await prisma.targetAllocation.deleteMany({
            where: {
                symbol: {
                    notIn: inputSymbols
                }
            }
        });

        // Upsert each target
        const results = await Promise.all(targets.map(async (t: any) => {
            return prisma.targetAllocation.upsert({
                where: { symbol: t.symbol },
                create: {
                    symbol: t.symbol,
                    targetPercentage: Number(t.targetPercentage),
                    yearlyDriftAdjustment: t.yearlyDriftAdjustment ? Number(t.yearlyDriftAdjustment) : null,
                    lastAdjustmentDate: new Date()
                },
                update: {
                    targetPercentage: Number(t.targetPercentage),
                    yearlyDriftAdjustment: t.yearlyDriftAdjustment !== undefined ? (t.yearlyDriftAdjustment ? Number(t.yearlyDriftAdjustment) : null) : undefined
                }
            });
        }));

        return NextResponse.json({ success: true, targets: results });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
