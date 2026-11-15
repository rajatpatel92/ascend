'use client';

import { useState, useEffect } from 'react';
import styles from './BenchmarkSettings.module.css';
import { MdAdd, MdDeleteOutline, MdShowChart } from 'react-icons/md';
import SymbolSearchInput from '@/components/SymbolSearchInput';

interface Benchmark {
    id: string;
    symbol: string;
    name: string;
    isSystem: boolean;
}

export default function BenchmarkSettings() {
    const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [newSymbol, setNewSymbol] = useState('');
    const [newName, setNewName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const loadBenchmarks = async (signal?: AbortSignal) => {
        try {
            const res = await fetch('/api/benchmarks', { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (Array.isArray(data)) setBenchmarks(data);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('Failed to load benchmarks', error);
            setErrorMessage('Failed to load benchmarks.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        const controller = new AbortController();
        loadBenchmarks(controller.signal);
        return () => controller.abort();
    }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newSymbol.trim() || !newName.trim()) return;

        setIsSubmitting(true);
        setErrorMessage(null);
        try {
            const res = await fetch('/api/benchmarks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: newSymbol.trim(), name: newName.trim() })
            });

            if (res.ok) {
                setNewSymbol('');
                setNewName('');
                await loadBenchmarks();
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorMessage(body.error || 'Failed to add benchmark.');
            }
        } catch (error) {
            console.error('Failed to add benchmark', error);
            setErrorMessage('Network error while adding benchmark.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Remove this benchmark from comparison charts?')) return;
        setErrorMessage(null);

        try {
            const res = await fetch(`/api/benchmarks/${id}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                await loadBenchmarks();
            } else {
                setErrorMessage('Failed to delete benchmark.');
            }
        } catch (error) {
            console.error('Failed to delete benchmark', error);
            setErrorMessage('Network error while deleting benchmark.');
        }
    };

    return (
        <section className={styles.card} aria-label="Benchmark configuration">
            <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                    <h2 className={styles.cardTitle}>
                        <MdShowChart size={20} aria-hidden="true" />
                        Benchmark Configuration
                    </h2>
                    <p className={styles.cardSubheading}>
                        Track market indices or reference ETFs across Evolution and Comparison charts.
                    </p>
                </div>
                <span className={styles.countPill}>{benchmarks.length} Active</span>
            </div>

            {errorMessage && (
                <div role="alert" className={styles.errorBanner}>
                    {errorMessage}
                </div>
            )}

            <form onSubmit={handleAdd} className={styles.form}>
                <div className={styles.formGroup}>
                    <label className={styles.label} htmlFor="benchmark-symbol">Symbol (Yahoo Finance)</label>
                    <SymbolSearchInput
                        value={newSymbol}
                        onChange={setNewSymbol}
                        onSelect={(sym, name) => {
                            setNewSymbol(sym);
                            setNewName(name);
                        }}
                        placeholder="e.g. ^GSPC, XEQT.TO"
                        required
                    />
                </div>
                <div className={styles.formGroup}>
                    <label className={styles.label} htmlFor="benchmark-name">Display Name</label>
                    <input
                        id="benchmark-name"
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="e.g. S&P 500"
                        className={styles.input}
                        required
                    />
                </div>
                <button type="submit" disabled={isSubmitting} className={styles.submitBtn}>
                    <MdAdd size={18} aria-hidden="true" />
                    {isSubmitting ? 'Adding...' : 'Add Benchmark'}
                </button>
            </form>

            <div className={styles.list}>
                <h3 className={styles.listTitle}>Active Benchmarks</h3>
                {isLoading ? (
                    <p className={styles.emptyText}>Loading benchmarks...</p>
                ) : benchmarks.length === 0 ? (
                    <p className={styles.emptyText}>No benchmarks configured yet.</p>
                ) : (
                    <div className={styles.grid}>
                        {benchmarks.map((b) => (
                            <div key={b.id} className={styles.item}>
                                <div className={styles.itemInfo}>
                                    <span className={styles.itemName}>{b.name}</span>
                                    <span className={styles.itemSymbol}>{b.symbol}</span>
                                </div>
                                {b.isSystem ? (
                                    <span className={styles.badge}>System</span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => handleDelete(b.id)}
                                        className={styles.deleteBtn}
                                        title="Remove Benchmark"
                                        aria-label={`Remove ${b.name}`}
                                    >
                                        <MdDeleteOutline size={20} aria-hidden="true" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
