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
        const types = await prisma.investmentType.findMany({
            orderBy: { name: 'asc' },
            include: {
                yahooInvestmentType: true
            }
        });
        return NextResponse.json(types);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch investment types' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }
    try {
        const { name, yahooInvestmentTypeId } = await request.json();
        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

        const newType = await prisma.investmentType.create({
            data: {
                name: name.toUpperCase(),
                yahooInvestmentTypeId: yahooInvestmentTypeId || null
            },
            include: {
                yahooInvestmentType: true
            }
        });
        return NextResponse.json(newType);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create investment type' }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }
    try {
        const { id, name, yahooInvestmentTypeId } = await request.json();
        if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

        const updatedType = await prisma.investmentType.update({
            where: { id },
            data: {
                name: name ? name.toUpperCase() : undefined,
                yahooInvestmentTypeId: yahooInvestmentTypeId // Can be null to clear
            },
            include: {
                yahooInvestmentType: true
            }
        });
        return NextResponse.json(updatedType);
    } catch (error) {
        console.error('Failed to update investment type', error);
        return NextResponse.json({ error: 'Failed to update investment type' }, { status: 500 });
    }
}
