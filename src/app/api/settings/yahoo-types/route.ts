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
        const types = await prisma.yahooInvestmentType.findMany({
            orderBy: { name: 'asc' }
        });
        return NextResponse.json(types);
    } catch (error) {
        console.error('Failed to fetch Yahoo investment types', error);
        return NextResponse.json({ error: 'Failed to fetch Yahoo investment types' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }
    try {
        const { name } = await request.json();
        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const newType = await prisma.yahooInvestmentType.create({
            data: { name: name.toUpperCase() }
        });
        return NextResponse.json(newType);
    } catch (error) {
        console.error('Failed to create Yahoo investment type', error);
        return NextResponse.json({ error: 'Failed to create Yahoo investment type' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

        await prisma.yahooInvestmentType.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete Yahoo investment type', error);
        return NextResponse.json({ error: 'Failed to delete Yahoo investment type' }, { status: 500 });
    }
}
