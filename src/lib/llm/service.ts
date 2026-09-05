import { prisma } from '@/lib/prisma';
import { GeminiProvider, OpenAIProvider, ClaudeProvider } from './providers';
import type { LLMProvider, LLMRequest, LLMResponse, LLMModel } from './types';

export class LLMService {
    private static getProvider(model: LLMModel): LLMProvider {
        switch (model) {
            case 'GEMINI':
                return new GeminiProvider();
            case 'GPT':
                return new OpenAIProvider();
            case 'CLAUDE':
                return new ClaudeProvider();
            default:
                throw new Error(`Unsupported model: ${model}`);
        }
    }

    private static async getApiKey(model: LLMModel): Promise<string> {
        const keyName = `${model}_API_KEY`;
        const setting = await prisma.systemSetting.findUnique({
            where: { key: keyName }
        });

        if (!setting || !setting.value) {
            throw new Error(`API Key not configured for ${model}`);
        }

        return setting.value;
    }

    static async analyze(model: LLMModel, request: LLMRequest): Promise<LLMResponse> {
        const provider = this.getProvider(model);
        const apiKey = await this.getApiKey(model);

        // Inject context into prompt if provided
        if (request.context) {
            request.prompt = `Given the following portfolio context:\n${request.context}\n\nUser Question: ${request.prompt}`;
        }

        return provider.generateResponse(request, apiKey);
    }
}
