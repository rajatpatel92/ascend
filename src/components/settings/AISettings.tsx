'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import styles from './Settings.module.css';
import { FaEye, FaEyeSlash, FaSave, FaRobot, FaPowerOff } from 'react-icons/fa';
import { useSession } from 'next-auth/react';

interface SessionUser {
    role?: string;
    preferredLLM?: string;
}

export default function AISettings() {
    const { data: session, update } = useSession();
    const sessionUser = session?.user as SessionUser | undefined;
    const userRole = sessionUser?.role || 'VIEWER';
    const currentModel = sessionUser?.preferredLLM || 'GEMINI';
    const isAdmin = userRole === 'ADMIN';
    const router = useRouter();

    // Config State (Admin)
    const [config, setConfig] = useState<Record<string, string>>({
        GEMINI_API_KEY: '',
        GPT_API_KEY: '',
        CLAUDE_API_KEY: '',
        AI_ENABLED: 'true'
    });

    // UI State
    const [isLoading, setIsLoading] = useState(userRole === 'ADMIN');
    const [showKey, setShowKey] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState<Record<string, boolean>>({});
    const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
        if (!isAdmin) return;

        const controller = new AbortController();
        fetch('/api/admin/llm-config', { signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!data || controller.signal.aborted) return;
                if (!data.AI_ENABLED) data.AI_ENABLED = 'true';
                setConfig((prev) => ({ ...prev, ...data }));
            })
            .catch((error: unknown) => {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load LLM config', error);
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsLoading(false);
            });

        return () => controller.abort();
    }, [isAdmin]);

    const handleSaveConfig = async (key: string, value: string) => {
        setSaving((prev) => ({ ...prev, [key]: true }));
        setFeedback(null);
        try {
            const res = await fetch('/api/admin/llm-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });

            if (!res.ok) throw new Error('Failed to save');

            setConfig((prev) => ({ ...prev, [key]: value }));
            setFeedback({
                type: 'success',
                message: key === 'AI_ENABLED'
                    ? `AI features ${value === 'true' ? 'enabled' : 'disabled'}.`
                    : 'Provider setting saved.'
            });

            if (key === 'AI_ENABLED') {
                router.refresh();
            }
        } catch {
            setFeedback({ type: 'error', message: 'Failed to save AI configuration setting.' });
        } finally {
            setSaving((prev) => ({ ...prev, [key]: false }));
        }
    };

    const handleModelChange = async (model: string) => {
        setSaving((prev) => ({ ...prev, model: true }));
        setFeedback(null);
        try {
            const res = await fetch('/api/user/llm-preference', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });

            if (res.ok) {
                await update({ preferredLLM: model });
                setFeedback({ type: 'success', message: `Preferred AI model updated to ${model}.` });
            } else {
                setFeedback({ type: 'error', message: 'Failed to update preferred model.' });
            }
        } catch (error) {
            console.error('Failed to update preference', error);
            setFeedback({ type: 'error', message: 'Network error while updating preference.' });
        } finally {
            setSaving((prev) => ({ ...prev, model: false }));
        }
    };

    const toggleShow = (key: string) => {
        setShowKey((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const providers = [
        { key: 'GEMINI_API_KEY', label: 'Google Gemini Pro' },
        { key: 'GPT_API_KEY', label: 'OpenAI GPT-4' },
        { key: 'CLAUDE_API_KEY', label: 'Anthropic Claude 3' }
    ];

    const isAIEnabled = config.AI_ENABLED === 'true';

    if (isLoading && isAdmin) {
        return (
            <section className={styles.card}>
                <p className={styles.helpText}>Loading AI settings...</p>
            </section>
        );
    }

    return (
        <section className={styles.card} aria-label="Portfolio intelligence settings">
            <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                    <h2 className={styles.cardTitle}>
                        <FaRobot size={18} aria-hidden="true" />
                        Portfolio Intelligence
                    </h2>
                    <p className={styles.cardSubheading}>
                        Select your preferred LLM and configure platform-wide provider keys.
                    </p>
                </div>

                {isAdmin && (
                    <div className={styles.toggleWrapper}>
                        <span className={styles.switchLabel}>
                            {isAIEnabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={isAIEnabled}
                            aria-label="Enable AI features platform-wide"
                            className={`${styles.toggleSwitch} ${isAIEnabled ? styles.active : ''}`}
                            onClick={() => handleSaveConfig('AI_ENABLED', isAIEnabled ? 'false' : 'true')}
                            disabled={saving['AI_ENABLED']}
                        >
                            <div className={styles.toggleHandle} />
                        </button>
                    </div>
                )}
            </div>

            {feedback && (
                <div
                    role={feedback.type === 'error' ? 'alert' : 'status'}
                    className={`${styles.feedbackText} ${feedback.type === 'error' ? styles.feedbackError : styles.feedbackSuccess}`}
                >
                    {feedback.message}
                </div>
            )}

            <div className={`${styles.section} ${!isAIEnabled ? styles.disabledSection : ''}`}>
                <div className={styles.field}>
                    <label htmlFor="llmSelect" className={styles.label}>Preferred Model</label>
                    <select
                        id="llmSelect"
                        value={currentModel}
                        onChange={(e) => handleModelChange(e.target.value)}
                        className={styles.select}
                        disabled={!isAIEnabled || saving['model']}
                    >
                        <option value="GEMINI">Google Gemini Pro (Fast &amp; Free Tier)</option>
                        <option value="GPT">OpenAI GPT-4 (Smart &amp; Verbose)</option>
                        <option value="CLAUDE">Anthropic Claude 3 (Nuanced &amp; Logical)</option>
                    </select>
                    <p className={styles.helpText}>
                        Select the AI model used for portfolio analysis and chat.
                    </p>
                </div>
            </div>

            {isAdmin && isAIEnabled && (
                <div className={styles.adminSection}>
                    <h3 className={styles.subTitle}>Provider Configuration</h3>
                    <div className={styles.grid}>
                        {providers.map((p) => (
                            <div key={p.key} className={styles.field}>
                                <label htmlFor={`provider-${p.key}`} className={styles.label}>{p.label} API Key</label>
                                <div className={styles.actionRow}>
                                    <div className={styles.inputWrapper}>
                                        <input
                                            id={`provider-${p.key}`}
                                            type={showKey[p.key] ? 'text' : 'password'}
                                            value={config[p.key] || ''}
                                            onChange={(e) => setConfig({ ...config, [p.key]: e.target.value })}
                                            className={styles.input}
                                            style={{ paddingRight: '42px' }}
                                            placeholder="Enter API Key"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => toggleShow(p.key)}
                                            className={styles.toggleBtn}
                                            aria-label={showKey[p.key] ? `Hide ${p.label} API key` : `Show ${p.label} API key`}
                                        >
                                            {showKey[p.key] ? <FaEyeSlash /> : <FaEye />}
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleSaveConfig(p.key, (config[p.key] || '').trim())}
                                        disabled={saving[p.key] || (config[p.key] || '').includes('...')}
                                        className={styles.saveBtn}
                                        title={(config[p.key] || '').includes('...') ? 'Cannot save masked key. Please enter a new key.' : 'Save API Key'}
                                    >
                                        <FaSave aria-hidden="true" />
                                        {saving[p.key] ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {isAdmin && !isAIEnabled && (
                <div className={styles.disabledMessage}>
                    <FaPowerOff size={22} aria-hidden="true" />
                    <p>AI features are currently disabled for the entire platform.</p>
                </div>
            )}
        </section>
    );
}
