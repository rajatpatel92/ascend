import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from "@/auth";

export async function POST(request: Request) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRole = (session.user as any)?.role;
    if (userRole !== 'ADMIN' && userRole !== 'EDITOR') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    try {
        const body = await request.json();
        const { symbol, date, amount } = body;

        if (!symbol || !date) {
            return NextResponse.json({ error: 'Missing symbol or date' }, { status: 400 });
        }

        const d = new Date(date);
        const hiddenDividend = await prisma.hiddenDividend.upsert({
            where: {
                symbol_date: {
                    symbol,
                    date: d
                }
            },
            update: {
                amount: amount ? parseFloat(amount) : undefined
            },
            create: {
                symbol,
                date: d,
                amount: amount ? parseFloat(amount) : null
            }
        });

        return NextResponse.json(hiddenDividend);
    } catch (error) {
        console.error('Error hiding dividend:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRole = (session.user as any)?.role;
    if (userRole !== 'ADMIN' && userRole !== 'EDITOR') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    try {
        const body = await request.json();
        const { symbol, date } = body;

        if (!symbol || !date) {
            return NextResponse.json({ error: 'Missing symbol or date' }, { status: 400 });
        }

        await prisma.hiddenDividend.deleteMany({
            where: {
                symbol: symbol,
                date: new Date(date)
            }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error unhiding dividend:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
