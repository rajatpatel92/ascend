import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const apiKey = request.headers.get('x-api-key');
    // Allow MCP API Key
    if (apiKey !== process.env.MCP_API_KEY) {
        // Continue to normal execution
    }
    try {
        const { searchParams } = new URL(request.url);
        const symbol = searchParams.get('symbol');

        if (!symbol) {
            return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
        }

        // Fetch all activities for the symbol
        const activities = await prisma.activity.findMany({
            where: {
                investment: {
                    symbol: symbol
                }
            },
            include: {
                investment: true
            }
        });

        // Fetch activity types to determine behavior
        const activityTypes = await prisma.activityType.findMany();
        const behaviorMap = new Map<string, string>();
        activityTypes.forEach(t => behaviorMap.set(t.name, t.behavior));

        // Default behaviors
        if (!behaviorMap.has('BUY')) behaviorMap.set('BUY', 'ADD');
        if (!behaviorMap.has('SELL')) behaviorMap.set('SELL', 'REMOVE');
        if (!behaviorMap.has('TRANSFER_IN')) behaviorMap.set('TRANSFER_IN', 'ADD');
        if (!behaviorMap.has('TRANSFER_OUT')) behaviorMap.set('TRANSFER_OUT', 'REMOVE');

        let quantity = 0;

        for (const activity of activities) {
            const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';

            if (behavior === 'ADD') {
                quantity += activity.quantity;
            } else if (behavior === 'REMOVE') {
                quantity -= activity.quantity;
            }
        }

        return NextResponse.json({ quantity });

    } catch (error) {
        console.error('Error fetching holdings:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
