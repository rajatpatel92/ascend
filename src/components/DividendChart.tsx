'use client';

import { useMemo } from 'react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import { parseLocalDate } from '@/lib/date-utils';

interface Props {
    data: { date: string; amount: number; drip?: number }[];
    period: 'month' | 'year';
}

const parseFlowDate = parseLocalDate;

export default function DividendChart({ data, period }: Props) {
    const { format } = useCurrency();

    const hasDrip = useMemo(
        () => data.some((d) => (d.drip ?? 0) > 0),
        [data]
    );

    const chartData = useMemo(() => {
        if (!hasDrip) return data;
        return data.map((d) => {
            const total = Math.max(0, d.amount);
            const rawDrip = Math.max(0, d.drip ?? 0);
            const reinvested = Math.min(total, rawDrip);
            const cash = Math.max(0, total - reinvested);
            return {
                ...d,
                reinvested,
                cash
            };
        });
    }, [data, hasDrip]);

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={260}>
                <BarChart data={chartData} margin={{ top: 16, right: 12, left: 6, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                    <XAxis
                        dataKey="date"
                        tickFormatter={(str) => {
                            const date = parseFlowDate(String(str));
                            if (period === 'year') return date.getFullYear().toString();
                            return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
                        }}
                        stroke="var(--text-secondary)"
                        fontSize={11}
                        tickMargin={8}
                        tickLine={false}
                        axisLine={false}
                    />
                    <YAxis
                        tickFormatter={(val) => format(val, { notation: 'compact' })}
                        stroke="var(--text-secondary)"
                        fontSize={11}
                        tickMargin={8}
                        width={68}
                        tickLine={false}
                        axisLine={false}
                    />
                    <Tooltip
                        formatter={(val, name) => [format(Number(val ?? 0)), String(name || 'Dividends')]}
                        labelFormatter={(label) => {
                            const date = parseFlowDate(String(label));
                            if (period === 'year') return date.getFullYear().toString();
                            return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
                        }}
                        contentStyle={{
                            backgroundColor: 'var(--card-bg)',
                            border: '1px solid var(--card-border)',
                            borderRadius: '0.5rem',
                            color: 'var(--text-primary)',
                            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.14)',
                            fontSize: '0.8125rem'
                        }}
                        itemStyle={{ color: 'var(--text-primary)' }}
                        labelStyle={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}
                    />
                    {hasDrip && (
                        <Legend
                            verticalAlign="top"
                            wrapperStyle={{ fontSize: '0.75rem', paddingBottom: '0.5rem' }}
                        />
                    )}
                    {hasDrip ? (
                        <>
                            <Bar dataKey="reinvested" stackId="div" name="Reinvested (DRIP)" fill="#0d9488" />
                            <Bar dataKey="cash" stackId="div" name="Cash" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                        </>
                    ) : (
                        <Bar dataKey="amount" name="Dividends" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    )}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
