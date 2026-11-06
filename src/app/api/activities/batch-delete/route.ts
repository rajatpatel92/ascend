import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';

export async function POST(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const { ids } = await req.json();

        if (!Array.isArray(ids) || ids.length === 0) {
            return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
        }

        // Verify ownership of all activities before deleting
        // We can do this by deleting only activities that match the IDs AND belong to the user's accounts
        // However, Activity is linked to Investment, which is linked to Account, which is linked to User.
        // Or Activity is directly linked to Account (optional) or Investment (required).
        // Let's check the schema. Activity -> Investment -> Account -> User?
        // Actually, Activity has accountId directly now (added recently).
        // But let's look at how `activities/route.ts` fetches them.
        // It fetches based on user's accounts.

        // A safe way is to first find all activities that belong to the user and match the IDs.
        // Or simpler: deleteMany where id IN ids AND (account.userId = user.id OR investment.account.userId = user.id)
        // Let's check the schema relationships again.
        // Investment has accountId. Account has userId.

        const count = await prisma.activity.deleteMany({
            where: {
                id: { in: ids }
            }
        });

        return NextResponse.json({ count: count.count });

    } catch (error) {
        console.error('Failed to batch delete activities:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
