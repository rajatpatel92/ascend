import test from 'node:test';
import assert from 'node:assert';
import { GeminiProvider, OpenAIProvider, ClaudeProvider } from './providers.ts';

test('GeminiProvider', async (t) => {
    const originalFetch = globalThis.fetch;

    t.afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('generates response successfully with system instruction and history', async () => {
        let calledUrl = '';
        let calledOptions: any = {};

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            calledUrl = url.toString();
            calledOptions = options;
            return new Response(JSON.stringify({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'Gemini generated response' }]
                        }
                    }
                ]
            }), { status: 200, statusText: 'OK' });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        const request = {
            prompt: 'What is my portfolio value?',
            systemInstruction: 'You are a helpful financial assistant.',
            history: [
                { role: 'user' as const, content: 'Hello' },
                { role: 'assistant' as const, content: 'Hi there!' }
            ]
        };

        const response = await provider.generateResponse(request, 'test-gemini-key');

        assert.strictEqual(response.content, 'Gemini generated response');
        assert.strictEqual(response.metadata?.model, 'gemini-flash-latest');
        assert.ok(calledUrl.includes('gemini-flash-latest:generateContent?key=test-gemini-key'));

        const parsedBody = JSON.parse(calledOptions.body);
        assert.strictEqual(parsedBody.contents.length, 3);
        assert.deepStrictEqual(parsedBody.contents[0], { role: 'user', parts: [{ text: 'Hello' }] });
        assert.deepStrictEqual(parsedBody.contents[1], { role: 'model', parts: [{ text: 'Hi there!' }] });
        assert.deepStrictEqual(parsedBody.contents[2], {
            role: 'user',
            parts: [{ text: 'System Instruction: You are a helpful financial assistant.\n\nWhat is my portfolio value?' }]
        });
    });

    await t.test('handles prompt without system instruction or history', async () => {
        let calledOptions: any = {};

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            calledOptions = options;
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'Simple answer' }] } }]
            }), { status: 200 });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        const response = await provider.generateResponse({ prompt: 'Hello Gemini' }, 'test-key');

        assert.strictEqual(response.content, 'Simple answer');
        const parsedBody = JSON.parse(calledOptions.body);
        assert.strictEqual(parsedBody.contents.length, 1);
        assert.deepStrictEqual(parsedBody.contents[0], {
            role: 'user',
            parts: [{ text: 'Hello Gemini' }]
        });
    });

    await t.test('handles empty response text gracefully', async () => {
        globalThis.fetch = (async () => {
            return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        const response = await provider.generateResponse({ prompt: 'Test' }, 'test-key');

        assert.strictEqual(response.content, '');
    });

    await t.test('handles 429 rate limit error gracefully', async () => {
        globalThis.fetch = (async () => {
            return new Response('Rate limit exceeded', { status: 429, statusText: 'Too Many Requests' });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        const response = await provider.generateResponse({ prompt: 'Test rate limit' }, 'test-key');

        assert.strictEqual(response.metadata?.error, 'Rate Limit');
        assert.ok(response.content.includes('Rate Limit Exceeded'));
    });

    await t.test('handles API error and attempts model listing if list succeeds', async () => {
        let fetchCount = 0;

        globalThis.fetch = (async (url: string | URL | Request) => {
            fetchCount++;
            if (fetchCount === 1) {
                return new Response('Invalid Request', { status: 400, statusText: 'Bad Request' });
            }
            // List models call
            return new Response(JSON.stringify({
                models: [{ name: 'models/gemini-pro' }, { name: 'models/gemini-flash' }]
            }), { status: 200 });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        await assert.rejects(
            async () => {
                await provider.generateResponse({ prompt: 'Test error' }, 'test-key');
            },
            (err: Error) => {
                assert.ok(err.message.includes('Gemini API Error: 400 Bad Request'));
                assert.ok(err.message.includes('Available models: models/gemini-pro, models/gemini-flash'));
                return true;
            }
        );
    });

    await t.test('handles API error and falls back when model listing fails', async () => {
        let fetchCount = 0;

        globalThis.fetch = (async () => {
            fetchCount++;
            if (fetchCount === 1) {
                return new Response('Internal error details', { status: 500, statusText: 'Internal Error' });
            }
            return new Response('Failed listing', { status: 500 });
        }) as typeof fetch;

        const provider = new GeminiProvider();
        await assert.rejects(
            async () => {
                await provider.generateResponse({ prompt: 'Test internal error' }, 'test-key');
            },
            (err: Error) => {
                assert.ok(err.message.includes('Gemini API Error: 500 Internal Error - Internal error details'));
                return true;
            }
        );
    });
});

test('OpenAIProvider', async (t) => {
    const originalFetch = globalThis.fetch;

    t.afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('generates response successfully with full request options', async () => {
        let calledUrl = '';
        let calledOptions: any = {};

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            calledUrl = url.toString();
            calledOptions = options;
            return new Response(JSON.stringify({
                model: 'gpt-4-turbo-2024-04-09',
                choices: [
                    {
                        message: {
                            content: 'OpenAI generated response'
                        }
                    }
                ]
            }), { status: 200 });
        }) as typeof fetch;

        const provider = new OpenAIProvider();
        const request = {
            prompt: 'Explain portfolio rebalancing',
            systemInstruction: 'You are an investment advisor.',
            history: [
                { role: 'user' as const, content: 'What is target allocation?' },
                { role: 'assistant' as const, content: 'It is the desired percentage...' }
            ]
        };

        const response = await provider.generateResponse(request, 'test-openai-key');

        assert.strictEqual(response.content, 'OpenAI generated response');
        assert.strictEqual(response.metadata?.model, 'gpt-4-turbo-2024-04-09');
        assert.strictEqual(calledUrl, 'https://api.openai.com/v1/chat/completions');

        assert.strictEqual(calledOptions.headers['Authorization'], 'Bearer test-openai-key');
        assert.strictEqual(calledOptions.headers['Content-Type'], 'application/json');

        const parsedBody = JSON.parse(calledOptions.body);
        assert.strictEqual(parsedBody.model, 'gpt-4-turbo');
        assert.strictEqual(parsedBody.temperature, 0.7);
        assert.deepStrictEqual(parsedBody.messages, [
            { role: 'system', content: 'You are an investment advisor.' },
            { role: 'user', content: 'What is target allocation?' },
            { role: 'assistant', content: 'It is the desired percentage...' },
            { role: 'user', content: 'Explain portfolio rebalancing' }
        ]);
    });

    await t.test('throws error on non-ok API response', async () => {
        globalThis.fetch = (async () => {
            return new Response('Unauthorized key', { status: 401 });
        }) as typeof fetch;

        const provider = new OpenAIProvider();
        await assert.rejects(
            async () => {
                await provider.generateResponse({ prompt: 'Hi' }, 'invalid-key');
            },
            (err: Error) => {
                assert.strictEqual(err.message, 'OpenAI API Error: Unauthorized key');
                return true;
            }
        );
    });
});

test('ClaudeProvider', async (t) => {
    const originalFetch = globalThis.fetch;

    t.afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('generates response successfully with full request options', async () => {
        let calledUrl = '';
        let calledOptions: any = {};

        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            calledUrl = url.toString();
            calledOptions = options;
            return new Response(JSON.stringify({
                model: 'claude-3-opus-20240229',
                content: [{ text: 'Claude response text' }]
            }), { status: 200 });
        }) as typeof fetch;

        const provider = new ClaudeProvider();
        const request = {
            prompt: 'Summarize earnings',
            systemInstruction: 'Be concise.',
            history: [{ role: 'user' as const, content: 'Analyze Apple earnings' }]
        };

        const response = await provider.generateResponse(request, 'test-claude-key');

        assert.strictEqual(response.content, 'Claude response text');
        assert.strictEqual(response.metadata?.model, 'claude-3-opus-20240229');
        assert.strictEqual(calledUrl, 'https://api.anthropic.com/v1/messages');

        assert.strictEqual(calledOptions.headers['x-api-key'], 'test-claude-key');
        assert.strictEqual(calledOptions.headers['anthropic-version'], '2023-06-01');

        const parsedBody = JSON.parse(calledOptions.body);
        assert.strictEqual(parsedBody.model, 'claude-3-opus-20240229');
        assert.strictEqual(parsedBody.max_tokens, 4096);
        assert.strictEqual(parsedBody.system, 'Be concise.');
        assert.deepStrictEqual(parsedBody.messages, [
            { role: 'user', content: 'Analyze Apple earnings' },
            { role: 'user', content: 'Summarize earnings' }
        ]);
    });

    await t.test('throws error on non-ok API response', async () => {
        globalThis.fetch = (async () => {
            return new Response('Overloaded', { status: 529 });
        }) as typeof fetch;

        const provider = new ClaudeProvider();
        await assert.rejects(
            async () => {
                await provider.generateResponse({ prompt: 'Hi' }, 'key');
            },
            (err: Error) => {
                assert.strictEqual(err.message, 'Claude API Error: Overloaded');
                return true;
            }
        );
    });
});
