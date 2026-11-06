import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from "@/auth";
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
        const { name, currency } = await request.json();

        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const slug = name.toLowerCase().replace(/\s+/g, '-');

        const updated = await prisma.platform.update({
            where: { id },
            data: { name, slug, currency }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update platform' }, { status: 500 });
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

        // Check if platform has activities
        const platform = await prisma.platform.findUnique({
            where: { id },
            include: { activities: true }
        });

        if (!platform) {
            return NextResponse.json({ error: 'Platform not found' }, { status: 404 });
        }

        if (platform.activities.length > 0) {
            return NextResponse.json({ error: 'Cannot delete platform with associated activities' }, { status: 400 });
        }

        await prisma.platform.delete({
            where: { id },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting platform:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
