import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { id } = await params;
        const { name, currency } = await request.json();

        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const updated = await prisma.accountType.update({
            where: { id },
            data: { name, currency }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update account type' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { id } = await params;
        await prisma.accountType.delete({
            where: { id }
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete account type' }, { status: 500 });
    }
}
