import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const { name, type, platformId, currency, isActive } = await request.json();

        if (!name || !type || !platformId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const updated = await prisma.account.update({
            where: { id },
            data: { 
                name, 
                type, 
                platformId, 
                currency,
                isActive: isActive !== undefined ? isActive : undefined
            }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        // Check if account has activities
        const account = await prisma.account.findUnique({
            where: { id },
            include: { activities: true }
        });

        if (!account) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        if (account.activities.length > 0) {
            return NextResponse.json({ error: 'Cannot delete account with associated activities' }, { status: 400 });
        }

        await prisma.account.delete({
            where: { id },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting account:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
