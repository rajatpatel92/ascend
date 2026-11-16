import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import { invalidatePortfolioMutationCaches } from '@/lib/cache-invalidation';

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

        const parsedQty = Number(quantity);
        const parsedPrice = Number(price);
        if (!date || !type || !currency || !platformId || !Number.isFinite(parsedQty) || parsedQty <= 0 || price === undefined || price === null || price === '' || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
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

        invalidatePortfolioMutationCaches();

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

        invalidatePortfolioMutationCaches();

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting activity:', error);
        return NextResponse.json({ error: 'Error deleting activity' }, { status: 500 });
    }
}
