
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';

export async function GET() {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const benchmarks = await prisma.benchmark.findMany({
            orderBy: { name: 'asc' }
        });
        return NextResponse.json(benchmarks);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch benchmarks' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const body = await req.json();
        const { symbol, name } = body;

        if (!symbol || !name) {
            return NextResponse.json({ error: 'Symbol and Name are required' }, { status: 400 });
        }

        const benchmark = await prisma.benchmark.create({
            data: {
                symbol,
                name,
                isSystem: false
            }
        });

        return NextResponse.json(benchmark);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create benchmark' }, { status: 500 });
    }
}
