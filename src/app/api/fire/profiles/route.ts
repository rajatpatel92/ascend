import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import {
    createDefaultFireProfile,
    normalizeFireCurrency,
    sanitizeFireProfile,
    type FireProfile,
    type FireProfileStore
} from '@/lib/fire-profiles';

const SETTING_KEY = 'fire_profiles_v1';

async function readOrSeedStore(seedCurrency = 'CAD'): Promise<FireProfileStore> {
    const existing = await prisma.systemSetting.findUnique({
        where: { key: SETTING_KEY }
    });

    const normalizedSeedCurrency = normalizeFireCurrency(seedCurrency);

    if (existing?.value) {
        try {
            const parsed = JSON.parse(existing.value) as Partial<FireProfileStore>;
            if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
                const profiles = parsed.profiles.map((p) =>
                    sanitizeFireProfile(p, normalizedSeedCurrency)
                );
                const activeExists = profiles.some((p) => p.id === parsed.activeProfileId);
                return {
                    activeProfileId: activeExists && parsed.activeProfileId
                        ? parsed.activeProfileId
                        : profiles[0].id,
                    profiles
                };
            }
        } catch {
            // Fall through to seed default profile
        }
    }

    const defaultProfile = createDefaultFireProfile(normalizedSeedCurrency);
    return {
        activeProfileId: defaultProfile.id,
        profiles: [defaultProfile]
    };
}

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { searchParams } = new URL(request.url);
        const seedCurrency = normalizeFireCurrency(searchParams.get('currency'));
        const store = await readOrSeedStore(seedCurrency);
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
            profile?: Partial<FireProfile>;
            activateOnly?: boolean;
            currency?: string;
        };

        const seedCurrency = normalizeFireCurrency(
            body.profile?.currency ?? body.currency
        );
        const store = await readOrSeedStore(seedCurrency);
        const nextProfiles = [...store.profiles];
        let nextActiveId = body.activeProfileId || store.activeProfileId;

        if (!body.activateOnly && body.profile && typeof body.profile === 'object') {
            const incoming = sanitizeFireProfile(body.profile, seedCurrency);
            const idx = nextProfiles.findIndex((p) => p.id === incoming.id);
            if (idx >= 0) {
                nextProfiles[idx] = incoming;
            } else {
                nextProfiles.push(incoming);
            }
            nextActiveId = incoming.id;
        } else if (body.activateOnly && body.activeProfileId) {
            const exists = nextProfiles.some((p) => p.id === body.activeProfileId);
            if (!exists) {
                return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
            }
        }

        const activeProfile = nextProfiles.find((p) => p.id === nextActiveId) || nextProfiles[0];
        if (!activeProfile) {
            return NextResponse.json({ error: 'No active profile available' }, { status: 400 });
        }

        const nextStore: FireProfileStore = {
            activeProfileId: activeProfile.id,
            profiles: nextProfiles
        };

        await prisma.systemSetting.upsert({
            where: { key: SETTING_KEY },
            create: {
                key: SETTING_KEY,
                value: JSON.stringify(nextStore),
                description: 'Saved FIRE independence planner simulation profiles'
            },
            update: {
                value: JSON.stringify(nextStore)
            }
        });

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
        const nextStore: FireProfileStore = {
            activeProfileId: nextActiveId,
            profiles: remaining
        };

        await prisma.systemSetting.upsert({
            where: { key: SETTING_KEY },
            create: {
                key: SETTING_KEY,
                value: JSON.stringify(nextStore),
                description: 'Saved FIRE independence planner simulation profiles'
            },
            update: {
                value: JSON.stringify(nextStore)
            }
        });

        return NextResponse.json({ success: true, ...nextStore });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
