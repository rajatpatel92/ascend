import styles from '@/app/(dashboard)/page.module.css';
import Skeleton from './Skeleton';

export default function DashboardSkeleton() {
    return (
        <div className={styles.container} role="status" aria-label="Loading portfolio dashboard">
            {/* Header Skeleton */}
            <header className={styles.header} aria-hidden="true">
                <div className={styles.headerLeft}>
                    <Skeleton width={240} height={32} style={{ marginBottom: '0.35rem' }} />
                    <Skeleton width={210} height={18} />
                </div>
                <Skeleton width={110} height={38} style={{ borderRadius: '0.5rem' }} />
            </header>

            <div className={styles.dashboardGrid}>
                {/* Tier 1: Executive Wealth Strip */}
                <section className={styles.executiveGrid} aria-hidden="true">
                    <div className={styles.heroCard}>
                        <div className={styles.heroTop}>
                            <Skeleton width={110} height={14} style={{ marginBottom: '0.25rem' }} />
                            <Skeleton width={220} height={42} style={{ marginBottom: '0.35rem' }} />
                            <Skeleton width={160} height={26} style={{ borderRadius: '9999px' }} />
                        </div>
                        <div className={styles.heroMetaGrid}>
                            <Skeleton width="85%" height={32} />
                            <Skeleton width="85%" height={32} />
                            <Skeleton width="85%" height={32} />
                        </div>
                    </div>

                    {[0, 1, 2].map(idx => (
                        <div key={idx} className={styles.kpiCard}>
                            <div className={styles.kpiHeader}>
                                <Skeleton width={110} height={14} />
                                <Skeleton width={64} height={22} style={{ borderRadius: '9999px' }} />
                            </div>
                            <Skeleton width={150} height={34} />
                            <div className={styles.kpiFooter}>
                                <Skeleton width="100%" height={6} style={{ borderRadius: '9999px' }} />
                                <Skeleton width="90%" height={14} />
                            </div>
                        </div>
                    ))}
                </section>

                {/* Tier 2: Unified Chart Skeleton */}
                <section className={styles.chartSection} aria-hidden="true">
                    <div className={styles.kpiCard} style={{ height: '440px', justifyContent: 'flex-start' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                            <Skeleton width={300} height={32} />
                            <Skeleton width={380} height={32} />
                        </div>
                        <Skeleton width="100%" height={42} style={{ borderRadius: '0.75rem' }} />
                        <Skeleton variant="rect" width="100%" height={310} />
                    </div>
                </section>

                {/* Tier 3: 3-Column Portfolio Pulse Row */}
                <section className={styles.pulseGrid} aria-hidden="true">
                    {[0, 1, 2].map(idx => (
                        <div key={idx} className={styles.pulseCard} style={{ minHeight: '280px' }}>
                            <div className={styles.pulseCardHeader}>
                                <Skeleton width={150} height={22} />
                                <Skeleton width={80} height={18} />
                            </div>
                            <Skeleton width="100%" height={32} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <Skeleton height={44} variant="rect" />
                                <Skeleton height={44} variant="rect" />
                                <Skeleton height={44} variant="rect" />
                            </div>
                        </div>
                    ))}
                </section>
            </div>
        </div>
    );
}
