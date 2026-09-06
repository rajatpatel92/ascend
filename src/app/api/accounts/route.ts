import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const platformId = searchParams.get('platformId');
    const includeInactive = searchParams.get('includeInactive') === 'true';

    try {
        const where: any = {};
        if (platformId) {
            where.platformId = platformId;
        }
        if (!includeInactive) {
            where.isActive = true;
        }

        const accounts = await prisma.account.findMany({
            where,
            include: { platform: true },
            orderBy: { name: 'asc' }
        });
        return NextResponse.json(accounts);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, type, platformId, currency } = body;

        if (!name || !type || !platformId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const account = await prisma.account.create({
            data: {
                name,
                type,
                platformId,
                currency: currency || 'USD'
            },
            include: { platform: true }
        });

        return NextResponse.json(account);
    } catch (error) {
        console.error('Error creating account:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
