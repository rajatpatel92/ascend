import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from "@/auth";

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = await params;
        const { name, behavior } = await request.json();

        // Check if system type
        const existing = await prisma.activityType.findUnique({ where: { id } });
        if (existing?.isSystem) {
            return NextResponse.json({ error: 'Cannot modify system activity types' }, { status: 403 });
        }

        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const updated = await prisma.activityType.update({
            where: { id },
            data: { name, behavior }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update activity type' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = await params;

        // Check if system type
        const existing = await prisma.activityType.findUnique({ where: { id } });
        if (existing?.isSystem) {
            return NextResponse.json({ error: 'Cannot delete system activity types' }, { status: 403 });
        }

        await prisma.activityType.delete({
            where: { id }
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete activity type' }, { status: 500 });
    }
}
