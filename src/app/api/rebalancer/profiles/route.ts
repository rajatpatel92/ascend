import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import type { RebalanceProfile, RebalanceProfileStore } from '@/lib/rebalance-extensions';

const SETTING_KEY = 'rebalancer_profiles_v1';

async function readOrSeedStore(): Promise<RebalanceProfileStore> {
    const existing = await prisma.systemSetting.findUnique({
        where: { key: SETTING_KEY }
    });

    if (existing?.value) {
        try {
            const parsed = JSON.parse(existing.value) as RebalanceProfileStore;
            if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
                return parsed;
            }
        } catch {
            // Fall through to seed from TargetAllocation
        }
    }

    const targets = await prisma.targetAllocation.findMany({
        orderBy: { symbol: 'asc' }
    });

    const defaultProfile: RebalanceProfile = {
        id: 'default',
        name: 'Default Portfolio',
        dimension: 'TICKER',
        tickerTargets: targets.map((t) => ({
            symbol: t.symbol,
            targetPercentage: t.targetPercentage,
            yearlyDriftAdjustment: t.yearlyDriftAdjustment,
            lastAdjustmentDate: t.lastAdjustmentDate ? new Date(t.lastAdjustmentDate).toISOString() : null,
            createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null
        })),
        categoryTargets: [],
        updatedAt: new Date().toISOString()
    };

    return {
        activeProfileId: defaultProfile.id,
        profiles: [defaultProfile]
    };
}

async function syncTargetAllocationTable(profile: RebalanceProfile): Promise<void> {
    const validTargets = (profile.tickerTargets || [])
        .map((t) => ({
            symbol: (t.symbol || '').trim().toUpperCase(),
            targetPercentage: Number(t.targetPercentage) || 0,
            yearlyDriftAdjustment: t.yearlyDriftAdjustment !== null && t.yearlyDriftAdjustment !== undefined
                ? Number(t.yearlyDriftAdjustment)
                : null
        }))
        .filter((t) => t.symbol !== '');

    const symbols = validTargets.map((t) => t.symbol);
    const upserts = validTargets.map((t) =>
        prisma.targetAllocation.upsert({
            where: { symbol: t.symbol },
            create: {
                symbol: t.symbol,
                targetPercentage: t.targetPercentage,
                yearlyDriftAdjustment: t.yearlyDriftAdjustment,
                lastAdjustmentDate: new Date()
            },
            update: {
                targetPercentage: t.targetPercentage,
                yearlyDriftAdjustment: t.yearlyDriftAdjustment
            }
        })
    );

    await prisma.$transaction([
        prisma.targetAllocation.deleteMany({
            where: { symbol: { notIn: symbols } }
        }),
        ...upserts
    ]);
}

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const store = await readOrSeedStore();
        return NextResponse.json(store);
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const body = (await request.json()) as {
            activeProfileId?: string;
            profile?: RebalanceProfile;
            activateOnly?: boolean;
        };

        const store = await readOrSeedStore();
        const nextProfiles = [...store.profiles];
        let nextActiveId = body.activeProfileId || store.activeProfileId;

        if (body.profile && typeof body.profile === 'object') {
            const incoming: RebalanceProfile = {
                ...body.profile,
                id: (body.profile.id || '').trim() || `profile-${Date.now()}`,
                name: (body.profile.name || '').trim() || 'Untitled Profile',
                dimension: body.profile.dimension === 'CATEGORY' ? 'CATEGORY' : 'TICKER',
                tickerTargets: Array.isArray(body.profile.tickerTargets) ? body.profile.tickerTargets : [],
                categoryTargets: Array.isArray(body.profile.categoryTargets) ? body.profile.categoryTargets : [],
                updatedAt: new Date().toISOString()
            };

            const idx = nextProfiles.findIndex((p) => p.id === incoming.id);
            if (idx >= 0) {
                nextProfiles[idx] = incoming;
            } else {
                nextProfiles.push(incoming);
            }
            nextActiveId = incoming.id;
        }

        const activeProfile = nextProfiles.find((p) => p.id === nextActiveId) || nextProfiles[0];
        if (!activeProfile) {
            return NextResponse.json({ error: 'No active profile available' }, { status: 400 });
        }
        nextActiveId = activeProfile.id;

        const nextStore: RebalanceProfileStore = {
            activeProfileId: nextActiveId,
            profiles: nextProfiles
        };

        await prisma.systemSetting.upsert({
            where: { key: SETTING_KEY },
            create: {
                key: SETTING_KEY,
                value: JSON.stringify(nextStore),
                description: 'Saved portfolio rebalancer profiles and category targets'
            },
            update: {
                value: JSON.stringify(nextStore)
            }
        });

        await syncTargetAllocationTable(activeProfile);

        return NextResponse.json({ success: true, ...nextStore });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { searchParams } = new URL(request.url);
        const profileId = searchParams.get('id')?.trim();
        if (!profileId) {
            return NextResponse.json({ error: 'Profile id is required' }, { status: 400 });
        }

        const store = await readOrSeedStore();
        if (store.profiles.length <= 1) {
            return NextResponse.json({ error: 'Cannot delete the last remaining profile' }, { status: 400 });
        }

        const remaining = store.profiles.filter((p) => p.id !== profileId);
        if (remaining.length === store.profiles.length) {
            return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
        }

        const nextActiveId = store.activeProfileId === profileId ? remaining[0].id : store.activeProfileId;
        const nextStore: RebalanceProfileStore = {
            activeProfileId: nextActiveId,
            profiles: remaining
        };

        await prisma.systemSetting.upsert({
            where: { key: SETTING_KEY },
            create: {
                key: SETTING_KEY,
                value: JSON.stringify(nextStore),
                description: 'Saved portfolio rebalancer profiles and category targets'
            },
            update: {
                value: JSON.stringify(nextStore)
            }
        });

        const activeProfile = remaining.find((p) => p.id === nextActiveId) || remaining[0];
        await syncTargetAllocationTable(activeProfile);

        return NextResponse.json({ success: true, ...nextStore });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
