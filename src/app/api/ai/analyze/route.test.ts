import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register ESM loader hook to intercept imports for Next.js, Prisma, Auth, LLMService, and erased TS type modules
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse {
          constructor(body, init) {
            this.body = body;
            this.status = init?.status || 200;
            this.headers = init?.headers || {};
          }
          static json(data, init) {
            const res = new NextResponse(JSON.stringify(data), init);
            res.data = data;
            return res;
          }
        }
      \`)
    };
  }

  if (specifier === '@/auth') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const auth = (...args) => globalThis.__mockAuth(...args);
      \`)
    };
  }

  if (specifier === '@/lib/prisma' || specifier === './prisma' || specifier === '@prisma/client') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = new Proxy({}, {
          get(target, prop) {
            return globalThis.__mockPrisma[prop];
          }
        });
        export class PrismaClient {}
        export const SystemSetting = {};
      \`)
    };
  }

  if (specifier === '@/lib/llm/service') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const LLMService = new Proxy({}, {
          get(target, prop) {
            return globalThis.__mockLLMService[prop];
          }
        });
      \`)
    };
  }

  if (specifier === '@/lib/llm/types') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const LLMModel = {};
      \`)
    };
  }

  if (specifier === '@/lib/portfolio-analytics') {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const PortfolioAnalytics = new Proxy({}, {
          get(target, prop) {
            return globalThis.__mockPortfolioAnalytics[prop];
          }
        });
      \`)
    };
  }

  if (specifier.startsWith('@/')) {
    let relativePath = specifier.replace('@/', './src/');
    if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.js') && !relativePath.endsWith('.tsx')) {
      relativePath += '.ts';
    }
    return nextResolve(new URL(relativePath, 'file://' + process.cwd() + '/').href, context);
  }

  return nextResolve(specifier, context);
}
`));

// Setup global mock holders
(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockPrisma = {};
(globalThis as any).__mockLLMService = {};
(globalThis as any).__mockPortfolioAnalytics = {};

// Import the route handler after loader hook setup
const { POST } = await import('./route.ts');

function createRequest(body: any): Request {
    return new Request('http://localhost:3000/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

test('POST /api/ai/analyze route handler', async (t) => {
    t.beforeEach(() => {
        // Reset mocks before each test
        (globalThis as any).__mockAuth = async () => ({
            user: { username: 'testuser', name: 'Test User' }
        });

        (globalThis as any).__mockPrisma = {
            user: {
                findUnique: async () => ({ preferredLLM: 'GEMINI', id: 'user-1' })
            },
            systemSetting: {
                findMany: async () => [
                    { key: 'AI_ENABLED', value: 'true' },
                    { key: 'GEMINI_API_KEY', value: 'gemini-key' },
                    { key: 'GPT_API_KEY', value: 'gpt-key' },
                    { key: 'CLAUDE_API_KEY', value: 'claude-key' }
                ]
            },
            activity: {
                findMany: async () => []
            }
        };

        (globalThis as any).__mockPortfolioAnalytics = {
            computeHoldingsState: () => ({})
        };

        (globalThis as any).__mockLLMService = {
            analyze: async () => ({ content: 'AI Analysis Result' })
        };
    });

    await t.test('returns 401 Unauthorized when session/username is missing', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const req = createRequest({ prompt: 'Analyze my portfolio' });
        const res = await POST(req);

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body, 'Unauthorized');
    });

    await t.test('returns 401 Unauthorized when session user has no username or name', async () => {
        (globalThis as any).__mockAuth = async () => ({ user: {} });

        const req = createRequest({ prompt: 'Analyze my portfolio' });
        const res = await POST(req);

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body, 'Unauthorized');
    });

    await t.test('returns 400 Bad Request when prompt is missing', async () => {
        const req = createRequest({});
        const res = await POST(req);

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body, 'Missing prompt');
    });

    await t.test('returns 503 Service Unavailable when AI features are disabled globally', async () => {
        (globalThis as any).__mockPrisma.systemSetting.findMany = async () => [
            { key: 'AI_ENABLED', value: 'false' }
        ];

        const req = createRequest({ prompt: 'Analyze my portfolio' });
        const res = await POST(req);

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body, 'AI features are currently disabled by the administrator.');
    });

    await t.test('returns 503 Service Unavailable when API key for requested model is missing', async () => {
        (globalThis as any).__mockPrisma.systemSetting.findMany = async () => [
            { key: 'AI_ENABLED', value: 'true' },
            { key: 'GEMINI_API_KEY', value: '' }
        ];

        const req = createRequest({ prompt: 'Analyze portfolio', model: 'GEMINI' });
        const res = await POST(req);

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body, 'API Key for GEMINI is not configured. Please contact the administrator.');
    });

    await t.test('uses user preferred LLM when model is not explicitly requested', async () => {
        let passedModel: string | null = null;
        (globalThis as any).__mockPrisma.user.findUnique = async () => ({ preferredLLM: 'GPT', id: 'user-1' });

        (globalThis as any).__mockLLMService.analyze = async (model: string) => {
            passedModel = model;
            return { content: 'GPT response' };
        };

        const req = createRequest({ prompt: 'Analyze portfolio' });
        const res = await POST(req);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(passedModel, 'GPT');
    });

    await t.test('falls back to GEMINI model when neither requested model nor preferred LLM is specified', async () => {
        let passedModel: string | null = null;
        (globalThis as any).__mockPrisma.user.findUnique = async () => ({ preferredLLM: null, id: 'user-1' });

        (globalThis as any).__mockLLMService.analyze = async (model: string) => {
            passedModel = model;
            return { content: 'Default response' };
        };

        const req = createRequest({ prompt: 'Analyze portfolio' });
        const res = await POST(req);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(passedModel, 'GEMINI');
    });

    await t.test('filters holdings > 0.0001 and passes constructed context and normalized history to LLMService', async () => {
        let capturedArgs: any = null;

        const activities = [
            { investment: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD', type: 'Stock' } },
            { investment: { symbol: 'TSLA', name: 'Tesla Inc.', currencyCode: 'USD', type: 'Stock' } },
            { investment: { symbol: 'ZERO', name: 'Zero Stock', currencyCode: 'USD', type: 'Stock' } }
        ];

        (globalThis as any).__mockPrisma.activity.findMany = async () => activities;

        (globalThis as any).__mockPortfolioAnalytics.computeHoldingsState = () => ({
            'AAPL': 10,
            'TSLA': 0.00005, // Should be filtered out (< 0.0001)
            'ZERO': 0        // Should be filtered out
        });

        (globalThis as any).__mockLLMService.analyze = async (model: string, payload: any) => {
            capturedArgs = { model, payload };
            return { content: 'Detailed analysis' };
        };

        const req = createRequest({
            prompt: 'How is my AAPL performance?',
            model: 'CLAUDE',
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'model', content: 'Hi! How can I help?' },
                { role: 'user', content: 'How is my AAPL performance?' }
            ]
        });

        const res = await POST(req);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.content, 'Detailed analysis');
        assert.strictEqual(capturedArgs.model, 'CLAUDE');
        assert.strictEqual(capturedArgs.payload.prompt, 'How is my AAPL performance?');

        // Verify context
        const parsedContext = JSON.parse(capturedArgs.payload.context);
        assert.strictEqual(parsedContext.length, 1);
        assert.deepStrictEqual(parsedContext[0], {
            symbol: 'AAPL',
            name: 'Apple Inc.',
            currency: 'USD',
            quantity: 10,
            type: 'Stock'
        });

        // Verify normalized history
        assert.deepStrictEqual(capturedArgs.payload.history, [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi! How can I help?' },
            { role: 'user', content: 'How is my AAPL performance?' }
        ]);
    });

    await t.test('handles fallback defaults for investment fields when investment mapping is incomplete', async () => {
        let capturedArgs: any = null;

        (globalThis as any).__mockPrisma.activity.findMany = async () => [
            { investment: { symbol: 'UNKNOWN' } } // Missing name, currencyCode, type
        ];

        (globalThis as any).__mockPortfolioAnalytics.computeHoldingsState = () => ({
            'UNKNOWN': 5
        });

        (globalThis as any).__mockLLMService.analyze = async (model: string, payload: any) => {
            capturedArgs = payload;
            return { content: 'OK' };
        };

        const req = createRequest({ prompt: 'Check holdings' });
        const res = await POST(req);

        assert.strictEqual(res.status, 200);
        const parsedContext = JSON.parse(capturedArgs.context);
        assert.deepStrictEqual(parsedContext[0], {
            symbol: 'UNKNOWN',
            name: 'UNKNOWN',
            currency: 'USD',
            quantity: 5,
            type: 'Unknown'
        });
    });

    await t.test('returns 500 status when an exception is thrown', async () => {
        const originalConsoleError = console.error;
        console.error = () => {}; // Mute expected log output

        try {
            (globalThis as any).__mockPrisma.user.findUnique = async () => {
                throw new Error('Database connection failed');
            };

            const req = createRequest({ prompt: 'Analyze my portfolio' });
            const res = await POST(req);

            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body, 'Database connection failed');
        } finally {
            console.error = originalConsoleError;
        }
    });
});
