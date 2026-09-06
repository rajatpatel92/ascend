'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MMM DD, YYYY';

interface DateContextType {
    dateFormat: DateFormat;
    setDateFormat: (format: DateFormat) => void;
    formatDate: (date: Date | string | number) => string;
}

const DateContext = createContext<DateContextType | undefined>(undefined);

export function DateProvider({ children }: { children: React.ReactNode }) {
    const [dateFormat, setDateFormat] = useState<DateFormat>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('portfolio_date_format');
            if (saved) {
                return saved as DateFormat;
            }
        }
        return 'MM/DD/YYYY';
    });
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMounted(true);
    }, []);

    useEffect(() => {
        if (mounted) {
            localStorage.setItem('portfolio_date_format', dateFormat);
        }
    }, [dateFormat, mounted]);

    const formatDate = (date: Date | string | number): string => {
        if (date === undefined || date === null || date === '') return '';

        let year: number;
        let month: number;
        let day: number;

        if (typeof date === 'string') {
            const trimmed = date.trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
                const datePart = trimmed.split('T')[0];
                const parts = datePart.split('-');
                year = parseInt(parts[0], 10);
                month = parseInt(parts[1], 10);
                day = parseInt(parts[2], 10);
            } else {
                const d = new Date(trimmed);
                if (isNaN(d.getTime())) return 'Invalid Date';
                year = d.getFullYear();
                month = d.getMonth() + 1;
                day = d.getDate();
            }
        } else if (date instanceof Date) {
            if (isNaN(date.getTime())) return 'Invalid Date';
            year = date.getFullYear();
            month = date.getMonth() + 1;
            day = date.getDate();
        } else if (typeof date === 'number') {
            const d = new Date(date);
            if (isNaN(d.getTime())) return 'Invalid Date';
            year = d.getFullYear();
            month = d.getMonth() + 1;
            day = d.getDate();
        } else {
            return 'Invalid Date';
        }

        if (isNaN(year) || isNaN(month) || isNaN(day)) return 'Invalid Date';

        const pad = (n: number) => n.toString().padStart(2, '0');
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        switch (dateFormat) {
            case 'DD/MM/YYYY':
                return `${pad(day)}/${pad(month)}/${year}`;
            case 'YYYY-MM-DD':
                return `${year}-${pad(month)}-${pad(day)}`;
            case 'MMM DD, YYYY':
                return `${monthNames[month - 1]} ${pad(day)}, ${year}`;
            case 'MM/DD/YYYY':
            default:
                return `${pad(month)}/${pad(day)}/${year}`;
        }
    };

    return (
        <DateContext.Provider value={{ dateFormat, setDateFormat, formatDate }}>
            {children}
        </DateContext.Provider>
    );
}

export function useDate() {
    const context = useContext(DateContext);
    if (context === undefined) {
        throw new Error('useDate must be used within a DateProvider');
    }
    return context;
}
