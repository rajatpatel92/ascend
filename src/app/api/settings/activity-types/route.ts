import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from "@/auth";
import { requireAuth } from '@/lib/api-auth';

export async function GET() {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        const types = await prisma.activityType.findMany({
            orderBy: { name: 'asc' }
        });
        return NextResponse.json(types);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch activity types' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }
    try {
        const { name, behavior } = await request.json();
        if (!name || !behavior) return NextResponse.json({ error: 'Name and behavior are required' }, { status: 400 });

        const newType = await prisma.activityType.create({
            data: {
                name: name.toUpperCase(),
                behavior
            }
        });
        return NextResponse.json(newType);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create activity type' }, { status: 500 });
    }
}
