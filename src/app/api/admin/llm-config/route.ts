import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';

export async function GET(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN'], false);
    if (!authResult.authorized) {
        return authResult.response;
    }

    const keys = ['GEMINI_API_KEY', 'GPT_API_KEY', 'CLAUDE_API_KEY', 'AI_ENABLED'];
    const settings = await prisma.systemSetting.findMany({
        where: { key: { in: keys } }
    });

    // Return masked values
    const config = settings.reduce((acc, setting) => {
        // Don't mask AI_ENABLED
        if (setting.key === 'AI_ENABLED') {
            acc[setting.key] = setting.value;
            return acc;
        }

        const visibleChars = 4;
        const value = setting.value;
        const masked = value.length > visibleChars
            ? `${value.substring(0, visibleChars)}...${value.substring(value.length - visibleChars)}`
            : '******';

        acc[setting.key] = masked;
        return acc;
    }, {} as Record<string, string>);

    return NextResponse.json(config);
}

export async function POST(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN'], false);
    if (!authResult.authorized) {
        return authResult.response;
    }

    const body = await req.json();
    const { key, value } = body;

    if (!key || !value) {
        return new NextResponse('Missing key or value', { status: 400 });
    }

    await prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: {
            key,
            value,
            description: `API Key for ${key.replace('_API_KEY', '')}`
        }
    });

    return NextResponse.json({ success: true });
}
