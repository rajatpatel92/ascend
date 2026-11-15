'use client';

import { useId } from 'react';

interface AscendLogoProps {
    compact?: boolean;
    size?: 'md' | 'lg';
    showSubtitle?: boolean;
    subtitle?: string;
}

export default function AscendLogo({
    compact = false,
    size = 'md',
    showSubtitle = true,
    subtitle = 'Portfolio',
}: AscendLogoProps) {
    const rawId = useId();
    const gradientId = `ascend-prism-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const iconDimension = size === 'lg' ? 44 : 34;

    return (
        <div
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: size === 'lg' ? '0.85rem' : '0.68rem',
                minWidth: 0,
            }}
        >
            <svg
                width={iconDimension}
                height={iconDimension}
                viewBox="0 0 36 36"
                fill="none"
                aria-hidden="true"
                style={{ flexShrink: 0, display: 'block' }}
            >
                <defs>
                    <linearGradient
                        id={gradientId}
                        x1="0"
                        y1="36"
                        x2="36"
                        y2="0"
                        gradientUnits="userSpaceOnUse"
                    >
                        <stop offset="0%" stopColor="#2563eb" />
                        <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                </defs>
                <rect width="36" height="36" rx="10" fill={`url(#${gradientId})`} />
                <path
                    d="M9 24L15.5 17.5L19.5 21.5L27 12"
                    stroke="#ffffff"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path
                    d="M21.5 12H27V17.5"
                    stroke="#ffffff"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>

            {!compact && (
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: 0,
                    }}
                >
                    <span
                        style={{
                            fontFamily: 'var(--font-display), var(--font-sans), sans-serif',
                            fontSize: size === 'lg' ? '1.5rem' : '1.08rem',
                            fontWeight: 700,
                            letterSpacing: '-0.025em',
                            lineHeight: 1.05,
                            color: 'var(--text-primary)',
                        }}
                    >
                        Ascend
                    </span>
                    {showSubtitle && (
                        <span
                            style={{
                                fontSize: size === 'lg' ? '0.78rem' : '0.7rem',
                                fontWeight: 500,
                                color: 'var(--text-secondary)',
                                lineHeight: 1.15,
                                marginTop: '0.18rem',
                            }}
                        >
                            {subtitle}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
