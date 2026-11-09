'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import styles from './AllocationChart.module.css';

interface DataPoint {
    name: string;
    value: number;
}

interface AllocationChartProps {
    title: string;
    data: DataPoint[];
    onSelect?: (name: string | null, event?: React.MouseEvent) => void;
    selectedName?: string | null;
    isPreConverted?: boolean;
}

const COLORS = [
    '#3b82f6', // Blue
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#8b5cf6', // Violet
    '#ec4899', // Pink
    '#06b6d4', // Cyan
    '#f97316', // Orange
    '#84cc16', // Lime
    '#a855f7', // Purple
    '#14b8a6', // Teal
    '#64748b', // Slate
    '#ef4444', // Red
    '#eab308', // Yellow
    '#6366f1', // Indigo
    '#d946ef', // Fuchsia
    '#0ea5e9'  // Sky Blue
];

export default function AllocationChart(props: AllocationChartProps) {
    const { title, data, onSelect, selectedName } = props;
    const { format, convert } = useCurrency();

    const chartData = data.map(item => ({
        ...item,
        value: (props.isPreConverted ? item.value : convert(item.value, 'USD'))
    })).filter(item => item.value > 0);

    const totalValue = chartData.reduce((sum, item) => sum + item.value, 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleClick = (data: any, index: number, e: React.MouseEvent) => {
        if (onSelect) {
            onSelect(data.name === selectedName ? null : data.name, e);
        }
    };

    if (chartData.length === 0) {
        return (
            <div className={styles.container}>
                <h3 className={styles.title}>{title}</h3>
                <div className={styles.empty}>No data available</div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <h3 className={styles.title}>{title}</h3>

            <div className={styles.chartArea}>
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={chartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={90}
                            paddingAngle={2}
                            dataKey="value"
                            onClick={handleClick}
                            cursor="pointer"
                        >
                            {chartData.map((entry, index) => (
                                <Cell
                                    key={`cell-${index}`}
                                    fill={COLORS[index % COLORS.length]}
                                    opacity={selectedName && selectedName !== entry.name ? 0.3 : 1}
                                    stroke={selectedName === entry.name ? 'var(--text-primary)' : 'none'}
                                    strokeWidth={selectedName === entry.name ? 2 : 0}
                                />
                            ))}
                        </Pie>
                        <Tooltip
                            formatter={(value: number) => format(value)}
                            contentStyle={{
                                backgroundColor: 'var(--card-bg)',
                                border: '1px solid var(--card-border)',
                                borderRadius: '0.5rem',
                                color: 'var(--text-primary)'
                            }}
                            itemStyle={{ color: 'var(--text-primary)' }}
                        />
                    </PieChart>
                </ResponsiveContainer>
            </div>

            <div className={styles.legendContainer}>
                {chartData.map((entry, index) => {
                    const isActive = !selectedName || selectedName === entry.name;
                    const percent = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;

                    return (
                        <div
                            key={`legend-${index}`}
                            className={`${styles.legendItem} ${isActive ? styles.active : styles.inactive}`}
                            onClick={(e) => handleClick(entry, index, e)}
                        >
                            <div
                                className={styles.legendColor}
                                style={{ backgroundColor: COLORS[index % COLORS.length] }}
                            />
                            <span>
                                {entry.name} <span style={{ opacity: 0.7 }}>({percent.toFixed(1)}%)</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
