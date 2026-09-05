import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register loader hook to resolve `@/` path aliases and missing `.ts` extensions in source imports
register(new URL(`data:text/javascript,${encodeURIComponent(`
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  let url = specifier;
  if (url.startsWith('@/')) {
    url = pathToFileURL(path.resolve('./src', url.slice(2))).href;
  }

  try {
    return await nextResolve(url, context);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      const parentDir = context.parentURL ? path.dirname(new URL(context.parentURL).pathname) : process.cwd();
      let targetPath = url.startsWith('file:') ? new URL(url).pathname : path.resolve(parentDir, url);
      if (!targetPath.endsWith('.ts') && fs.existsSync(targetPath + '.ts')) {
        return nextResolve(pathToFileURL(targetPath + '.ts').href, context);
      }
    }
    throw err;
  }
}
`)}`));

const { LLMService } = await import('./service');
const { prisma } = await import('../prisma');

type LLMModel = 'GEMINI' | 'GPT' | 'CLAUDE';

interface LLMRequest {
    prompt: string;
    context?: string;
    systemInstruction?: string;
    history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

test('LLMService', async (t) => {
    const originalFetch = globalThis.fetch;
    const settingsMap = new Map<string, string>();

    // Mock prisma.systemSetting.findUnique
    (prisma as any).systemSetting = {
        findUnique: async (args: { where: { key: string } }) => {
            const val = settingsMap.get(args.where.key);
            if (val === undefined) return null;
            return { key: args.where.key, value: val };
        }
    };

    t.beforeEach(() => {
        settingsMap.clear();
        globalThis.fetch = originalFetch;
    });

    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('analyze - succeeds for GEMINI model and calls provider correctly', async () => {
        settingsMap.set('GEMINI_API_KEY', 'gemini-secret-key');

        let capturedUrl = '';
        let capturedBody: any = null;

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            capturedUrl = url.toString();
            if (options?.body) {
                capturedBody = JSON.parse(options.body as string);
            }
            return {
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: 'Gemini generated insight' }] } }]
                })
            } as Response;
        }) as typeof fetch;

        const req: LLMRequest = { prompt: 'How is my portfolio doing?' };
        const res = await LLMService.analyze('GEMINI', req);

        assert.ok(capturedUrl.includes('key=gemini-secret-key'));
        assert.strictEqual(capturedBody.contents[0].parts[0].text, 'How is my portfolio doing?');
        assert.strictEqual(res.content, 'Gemini generated insight');
        assert.strictEqual(res.metadata?.model, 'gemini-flash-latest');
    });

    await t.test('analyze - succeeds for GPT model and calls provider correctly', async () => {
        settingsMap.set('GPT_API_KEY', 'gpt-secret-key');

        let capturedHeaders: any = null;
        let capturedBody: any = null;

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            capturedHeaders = options?.headers;
            if (options?.body) {
                capturedBody = JSON.parse(options.body as string);
            }
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'GPT generated insight' } }],
                    model: 'gpt-4-turbo'
                })
            } as Response;
        }) as typeof fetch;

        const req: LLMRequest = { prompt: 'Explain diversification.' };
        const res = await LLMService.analyze('GPT', req);

        assert.strictEqual(capturedHeaders['Authorization'], 'Bearer gpt-secret-key');
        assert.strictEqual(capturedBody.messages[0].content, 'Explain diversification.');
        assert.strictEqual(res.content, 'GPT generated insight');
        assert.strictEqual(res.metadata?.model, 'gpt-4-turbo');
    });

    await t.test('analyze - succeeds for CLAUDE model and calls provider correctly', async () => {
        settingsMap.set('CLAUDE_API_KEY', 'claude-secret-key');

        let capturedHeaders: any = null;
        let capturedBody: any = null;

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            capturedHeaders = options?.headers;
            if (options?.body) {
                capturedBody = JSON.parse(options.body as string);
            }
            return {
                ok: true,
                json: async () => ({
                    content: [{ text: 'Claude generated insight' }],
                    model: 'claude-3-opus-20240229'
                })
            } as Response;
        }) as typeof fetch;

        const req: LLMRequest = { prompt: 'Summarize risk exposures.' };
        const res = await LLMService.analyze('CLAUDE', req);

        assert.strictEqual(capturedHeaders['x-api-key'], 'claude-secret-key');
        assert.strictEqual(capturedBody.messages[0].content, 'Summarize risk exposures.');
        assert.strictEqual(res.content, 'Claude generated insight');
        assert.strictEqual(res.metadata?.model, 'claude-3-opus-20240229');
    });

    await t.test('analyze - injects portfolio context into prompt when context is provided', async () => {
        settingsMap.set('GEMINI_API_KEY', 'gemini-secret-key');

        let capturedBody: any = null;

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            if (options?.body) {
                capturedBody = JSON.parse(options.body as string);
            }
            return {
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: 'Context aware answer' }] } }]
                })
            } as Response;
        }) as typeof fetch;

        const contextData = '{"holdings": ["AAPL", "MSFT"], "totalValue": 50000}';
        const req: LLMRequest = {
            prompt: 'Should I rebalance?',
            context: contextData
        };

        const res = await LLMService.analyze('GEMINI', req);

        const expectedPrompt = `Given the following portfolio context:\n${contextData}\n\nUser Question: Should I rebalance?`;
        assert.strictEqual(capturedBody.contents[0].parts[0].text, expectedPrompt);
        assert.strictEqual(req.prompt, expectedPrompt);
        assert.strictEqual(res.content, 'Context aware answer');
    });

    await t.test('analyze - preserves prompt when context is not provided', async () => {
        settingsMap.set('GPT_API_KEY', 'gpt-secret-key');

        let capturedBody: any = null;

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            if (options?.body) {
                capturedBody = JSON.parse(options.body as string);
            }
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'No context answer' } }],
                    model: 'gpt-4-turbo'
                })
            } as Response;
        }) as typeof fetch;

        const req: LLMRequest = { prompt: 'What is stock equity?' };
        await LLMService.analyze('GPT', req);

        assert.strictEqual(capturedBody.messages[0].content, 'What is stock equity?');
        assert.strictEqual(req.prompt, 'What is stock equity?');
    });

    await t.test('analyze - throws error when API key is not configured in settings', async () => {
        await assert.rejects(
            async () => {
                await LLMService.analyze('GEMINI', { prompt: 'Hello' });
            },
            {
                name: 'Error',
                message: 'API Key not configured for GEMINI'
            }
        );
    });

    await t.test('analyze - throws error when API key in settings is empty', async () => {
        settingsMap.set('GPT_API_KEY', '');

        await assert.rejects(
            async () => {
                await LLMService.analyze('GPT', { prompt: 'Hello' });
            },
            {
                name: 'Error',
                message: 'API Key not configured for GPT'
            }
        );
    });

    await t.test('analyze - throws error for unsupported model', async () => {
        settingsMap.set('UNKNOWN_API_KEY', 'some-key');

        await assert.rejects(
            async () => {
                await LLMService.analyze('UNKNOWN' as LLMModel, { prompt: 'Hello' });
            },
            {
                name: 'Error',
                message: 'Unsupported model: UNKNOWN'
            }
        );
    });
});
