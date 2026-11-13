'use client';

import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer
} from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import { parseLocalDate } from '@/lib/date-utils';

interface Props {
    data: { date: string; amount: number }[];
    period: 'month' | 'year';
}

const parseFlowDate = parseLocalDate;

export default function DividendChart({ data, period }: Props) {
    const { format } = useCurrency();

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={260}>
                <BarChart data={data} margin={{ top: 16, right: 12, left: 6, bottom: 8 }}>
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
                        formatter={(val) => [format(Number(val ?? 0)), 'Dividends']}
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
                    <Bar dataKey="amount" name="Dividends" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
