import type { LLMProvider, LLMRequest, LLMResponse } from './types';

// Gemini Provider
export class GeminiProvider implements LLMProvider {
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

    async generateResponse(request: LLMRequest, apiKey: string): Promise<LLMResponse> {
        // Using 'gemini-flash-latest' as it was listed in available models and should have free quota
        // gemini-2.0-flash had 0 quota (experimental/preview restriction)
        const model = 'gemini-flash-latest';
        const url = `${this.baseUrl}/${model}:generateContent?key=${apiKey}`;

        const contents = [];

        // Add history if present (mapped to Gemini format)
        if (request.history && request.history.length > 0) {
            request.history.forEach(msg => {
                contents.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.content }]
                });
            });
        }

        // Add current prompt
        contents.push({
            role: 'user',
            parts: [{ text: (request.systemInstruction ? `System Instruction: ${request.systemInstruction}\n\n` : '') + request.prompt }]
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents })
        });

        if (!response.ok) {
            const errText = await response.text();

            // Handle Rate Limits gracefully
            if (response.status === 429) {
                return {
                    content: "I apologize, but I'm currently receiving too many requests (Rate Limit Exceeded). Please try again in a minute.",
                    metadata: { model, error: 'Rate Limit' }
                };
            }

            // Try to list available models to help debug
            try {
                const listUrl = `${this.baseUrl}?key=${apiKey}`;
                const listRes = await fetch(listUrl);
                if (listRes.ok) {
                    const listData = await listRes.json();
                    const models = listData.models?.map((m: any) => m.name) || [];
                    throw new Error(`Gemini API Error: ${response.status} ${response.statusText}. Available models: ${models.join(', ')}`);
                }
            } catch (listErr) {
                // Ignore list error and throw original
            }

            throw new Error(`Gemini API Error: ${response.status} ${response.statusText} - ${errText}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return {
            content: text,
            metadata: { model }
        };
    }
}

// OpenAI Provider
export class OpenAIProvider implements LLMProvider {
    async generateResponse(request: LLMRequest, apiKey: string): Promise<LLMResponse> {
        const model = 'gpt-4-turbo'; // Default to a capable model

        const messages = [];
        if (request.systemInstruction) {
            messages.push({ role: 'system', content: request.systemInstruction });
        }
        // Add history
        if (request.history) {
            messages.push(...request.history);
        }
        messages.push({ role: 'user', content: request.prompt });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API Error: ${error}`);
        }

        const data = await response.json();
        return {
            content: data.choices[0].message.content,
            metadata: { model: data.model }
        };
    }
}

// Anthropic Provider
export class ClaudeProvider implements LLMProvider {
    async generateResponse(request: LLMRequest, apiKey: string): Promise<LLMResponse> {
        const model = 'claude-3-opus-20240229'; // Or sonnet

        const messages = [];
        // Claude handles system prompts separately in top-level param usually, but messages work too
        // History
        if (request.history) {
            messages.push(...request.history);
        }
        messages.push({ role: 'user', content: request.prompt });

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                system: request.systemInstruction,
                messages
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Claude API Error: ${error}`);
        }

        const data = await response.json();
        return {
            content: data.content[0].text,
            metadata: { model: data.model }
        };
    }
}
