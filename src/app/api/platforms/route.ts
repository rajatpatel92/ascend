import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from "@/auth";

export async function GET(request: Request) {
    const apiKey = request.headers.get('x-api-key');
    const session = await auth();
    if (apiKey !== process.env.MCP_API_KEY && !session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const platforms = await prisma.platform.findMany();
        return NextResponse.json(platforms);
    } catch (error) {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const apiKey = request.headers.get('x-api-key');
    const session = await auth();
    if (apiKey !== process.env.MCP_API_KEY && !session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { name, currency } = body;

        if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });

        const slug = name.toLowerCase().replace(/\s+/g, '-');

        const platform = await prisma.platform.create({
            data: {
                name,
                slug,
                currency: currency || 'USD'
            },
        });

        return NextResponse.json(platform);
    } catch (error) {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
