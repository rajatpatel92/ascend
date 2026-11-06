import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { searchParams } = new URL(request.url);
        const symbol = searchParams.get('symbol');

        const where: any = symbol ? { symbol: symbol } : {};

        // Only return investments that have at least one activity (Active or Sold)
        // This hides investments that exist in DB but have no associated transactions (e.g. all deleted)
        where.activities = {
            some: {}
        };

        const investments = await prisma.investment.findMany({
            where,
            select: {
                symbol: true,
                name: true,
                type: true
            },
            distinct: ['symbol'],
            orderBy: {
                symbol: 'asc'
            }
        });

        return NextResponse.json(investments);

    } catch (error) {
        console.error('Error fetching investments:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
