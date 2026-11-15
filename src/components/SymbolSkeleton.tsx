import styles from '@/app/(dashboard)/analysis/[symbol]/page.module.css';
import Skeleton from './Skeleton';

export default function SymbolSkeleton() {
    return (
        <div className={styles.container}>
            <div className={styles.backLinkContainer}>
                <Skeleton width={180} height={28} />
            </div>

            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <div className={styles.titleRow}>
                        <Skeleton width={260} height={34} />
                        <Skeleton width={70} height={26} />
                    </div>
                    <div className={styles.metaChips}>
                        <Skeleton width={52} height={22} />
                        <Skeleton width={110} height={22} />
                        <Skeleton width={90} height={22} />
                    </div>
                </div>
                <div className={styles.headerActions}>
                    <Skeleton width={132} height={36} />
                </div>
            </header>

            <div className={styles.tablistBar} style={{ paddingBottom: '0.5rem', display: 'flex', gap: '0.75rem' }}>
                <Skeleton width={90} height={28} />
                <Skeleton width={110} height={28} />
            </div>

            <div className={styles.content}>
                <section className={styles.executiveGrid}>
                    <div className={styles.kpiCard} style={{ minHeight: '164px' }}>
                        <Skeleton width={110} height={14} />
                        <Skeleton width={180} height={38} />
                        <Skeleton width={210} height={24} />
                    </div>
                    {[1, 2, 3].map(i => (
                        <div key={i} className={styles.kpiCard} style={{ minHeight: '164px' }}>
                            <Skeleton width={100} height={14} />
                            <Skeleton width={140} height={32} />
                            <Skeleton width="100%" height={18} />
                        </div>
                    ))}
                </section>

                <section
                    style={{
                        background: 'var(--card-bg)',
                        border: '1px solid var(--card-border)',
                        borderRadius: '1rem',
                        padding: '1.5rem',
                        height: '440px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1rem',
                    }}
                >
                    <Skeleton width={220} height={24} />
                    <Skeleton variant="rect" height="100%" />
                </section>

                <div className={styles.splitGrid}>
                    <div className={styles.detailCard} style={{ minHeight: '220px' }}>
                        <Skeleton width={170} height={22} />
                        <Skeleton width="100%" height={12} />
                        <Skeleton width="100%" height={42} />
                        <Skeleton width="100%" height={42} />
                    </div>
                    <div className={styles.detailCard} style={{ minHeight: '220px' }}>
                        <Skeleton width={170} height={22} />
                        <Skeleton width="100%" height={12} />
                        <Skeleton width="100%" height={42} />
                        <Skeleton width="100%" height={42} />
                    </div>
                </div>
            </div>
        </div>
    );
}
