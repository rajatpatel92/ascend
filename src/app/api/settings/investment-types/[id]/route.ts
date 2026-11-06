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
        const { name } = await request.json();

        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const updated = await prisma.investmentType.update({
            where: { id },
            data: { name }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update investment type' }, { status: 500 });
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
        await prisma.investmentType.delete({
            where: { id }
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete investment type' }, { status: 500 });
    }
}
