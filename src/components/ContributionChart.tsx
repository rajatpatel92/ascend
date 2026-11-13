'use client';

import { useMemo } from 'react';
import {
    ComposedChart,
    Bar,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
    ReferenceLine
} from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { parseLocalDate } from '@/lib/date-utils';

interface Props {
    data: { date: string; inflow: number; outflow: number }[];
    period: 'week' | 'month' | 'year';
}

const parseFlowDate = parseLocalDate;

export default function ContributionChart({ data, period }: Props) {
    const { format } = useCurrency();
    const { formatDate } = useDate();

    const processedData = useMemo(
        () =>
            data.map(d => ({
                ...d,
                outflow: -Math.abs(d.outflow),
                net: d.inflow - Math.abs(d.outflow)
            })),
        [data]
    );

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={260}>
                <ComposedChart data={processedData} margin={{ top: 16, right: 10, left: 6, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                    <XAxis
                        dataKey="date"
                        tickFormatter={(str) => {
                            const date = parseFlowDate(String(str));
                            if (period === 'year') return date.getFullYear().toString();
                            if (period === 'month') {
                                return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
                            }
                            return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
                        formatter={(val) => format(Number(val ?? 0))}
                        labelFormatter={(label) => {
                            const date = parseFlowDate(String(label));
                            if (period === 'year') return date.getFullYear().toString();
                            if (period === 'month') {
                                return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
                            }
                            return formatDate(date);
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
                    <Legend verticalAlign="top" wrapperStyle={{ fontSize: '0.75rem', paddingBottom: '0.5rem' }} />
                    <ReferenceLine y={0} stroke="var(--text-secondary)" strokeOpacity={0.5} />
                    <Bar dataKey="inflow" name="Inflow" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outflow" name="Outflow" fill="#ef4444" radius={[0, 0, 4, 4]} />
                    <Line type="monotone" dataKey="net" name="Net Flow" stroke="#3b82f6" dot={false} strokeWidth={2} />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}
