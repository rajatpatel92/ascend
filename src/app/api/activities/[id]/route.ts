import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const { id } = await params;
        const body = await request.json();
        const { date, type, quantity, price, fee, currency, platformId, accountId } = body;

        // Validate required fields
        if (!date || !type || !quantity || !price || !currency || !platformId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const activity = await prisma.activity.update({
            where: { id: id }, // ID is String (UUID)
            data: {
                date: new Date(date),
                type,
                quantity: parseFloat(quantity),
                price: parseFloat(price),
                fee: fee ? parseFloat(fee) : 0,
                currency,
                platformId: platformId, // PlatformID is String (UUID)
                accountId: accountId || null,
            },
        });

        return NextResponse.json(activity);
    } catch (error) {
        console.error('Error updating activity:', error);
        return NextResponse.json({ error: 'Error updating activity' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const { id } = await params;
        await prisma.activity.delete({
            where: { id: id }, // ID is String (UUID)
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting activity:', error);
        return NextResponse.json({ error: 'Error deleting activity' }, { status: 500 });
    }
}
