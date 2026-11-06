import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { LLMService } from '@/lib/llm/service';
import { NextResponse } from 'next/server';
import { LLMModel } from '@/lib/llm/types';
import { SystemSetting } from '@prisma/client';

export async function POST(req: Request) {
    const session = await auth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const username = (session?.user as any)?.username || session?.user?.name;

    if (!username) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((session?.user as any)?.aiEnabled === false) {
        return new NextResponse('AI features are disabled for your account.', { status: 403 });
    }

    const { prompt, messages, model: requestedModel } = await req.json();

    if (!prompt) {
        return new NextResponse('Missing prompt', { status: 400 });
    }

    try {
        // 1. Get User Preference & Global Config
        const [user, settings] = await Promise.all([
            prisma.user.findUnique({
                where: { username },
                select: { preferredLLM: true, id: true }
            }),
            prisma.systemSetting.findMany({
                where: { key: { in: ['AI_ENABLED', 'GEMINI_API_KEY', 'GPT_API_KEY', 'CLAUDE_API_KEY'] } }
            })
        ]);

        const settingsMap = settings.reduce((acc: Record<string, string>, s: SystemSetting) => ({ ...acc, [s.key]: s.value }), {} as Record<string, string>);

        // Check Global Toggle
        if (settingsMap['AI_ENABLED'] === 'false') {
            return new NextResponse('AI features are currently disabled by the administrator.', { status: 503 });
        }

        const model = (requestedModel || user?.preferredLLM || 'GEMINI') as LLMModel;

        // Check API Key
        const keyMap: Record<LLMModel, string> = {
            'GEMINI': 'GEMINI_API_KEY',
            'GPT': 'GPT_API_KEY',
            'CLAUDE': 'CLAUDE_API_KEY'
        };

        if (!settingsMap[keyMap[model]]) {
            return new NextResponse(`API Key for ${model} is not configured. Please contact the administrator.`, { status: 503 });
        }

        // 2. Fetch Portfolio Data (Simplified Context)
        // In a real scenario, we might want to be selective about what data we send
        // 2. Fetch Portfolio Data (Filtered for Current Holdings)
        // Fetch all activities to calculate current state
        const activities = await prisma.activity.findMany({
            include: {
                investment: true
            },
            orderBy: { date: 'asc' }
        });

        // Import dynamically to avoid circular deps if any (though likely fine here)
        const { PortfolioAnalytics } = await import('@/lib/portfolio-analytics');

        // Calculate current quantities
        const currentHoldingsMap = PortfolioAnalytics.computeHoldingsState(activities);

        // Filter valid holdings and map to context format
        const portfolio = Object.entries(currentHoldingsMap)
            .filter(([_, qty]) => qty > 0.0001) // Filter out sold/zero positions
            .map(([symbol, qty]) => {
                // Find investment details
                const activity = activities.find(a => a.investment.symbol === symbol);
                return {
                    symbol: symbol,
                    name: activity?.investment.name || symbol,
                    currency: activity?.investment.currencyCode || 'USD',
                    quantity: qty,
                    type: activity?.investment.type || 'Unknown'
                };
            });

        const context = JSON.stringify(portfolio);

        // 3. Call LLM Service
        const history = messages?.map((m: any) => ({
            role: m.role === 'user' ? 'user' : 'assistant', // Normalize
            content: m.content
        })) || [];

        const response = await LLMService.analyze(model, {
            prompt,
            context,
            history,
            systemInstruction: "You are a helpful financial portfolio assistant. Analyze the user's portfolio data provided in context. Be concise and insightful."
        });

        return NextResponse.json(response);

    } catch (error: any) {
        console.error('Analysis failed:', error);
        return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
    }
}
