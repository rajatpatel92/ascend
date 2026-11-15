'use client';

import { FaSpinner, FaTimes } from 'react-icons/fa';
import { MdWarningAmber } from 'react-icons/md';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import styles from './ActivitiesModal.module.css';

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    description: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'danger' | 'primary';
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    isOpen,
    title,
    description,
    detail,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'danger',
    loading = false,
    onConfirm,
    onCancel
}: ConfirmDialogProps) {
    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen,
        onClose: onCancel,
        disabled: loading
    });

    if (!isOpen) return null;

    return (
        <div
            className={styles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${styles.modal} ${styles.modalSm}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
            >
                <div className={styles.header}>
                    <div className={styles.headerTitleGroup}>
                        <span
                            className={`${styles.headerIcon} ${tone === 'danger' ? styles.headerIconDanger : ''}`}
                            aria-hidden="true"
                        >
                            <MdWarningAmber />
                        </span>
                        <div className={styles.headerText}>
                            <h2 id="confirm-dialog-title" className={styles.title}>
                                {title}
                            </h2>
                            <p className={styles.subtitle}>{description}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={onCancel}
                        disabled={loading}
                        aria-label="Close confirmation dialog"
                    >
                        <FaTimes aria-hidden="true" />
                    </button>
                </div>

                {detail && (
                    <div className={styles.body}>
                        <div className={tone === 'danger' ? styles.warningBanner : styles.infoBanner}>
                            <span>{detail}</span>
                        </div>
                    </div>
                )}

                <div className={styles.footer}>
                    <div className={styles.footerEnd}>
                        <button
                            type="button"
                            className={styles.secondaryBtn}
                            onClick={onCancel}
                            disabled={loading}
                        >
                            {cancelLabel}
                        </button>
                        <button
                            type="button"
                            className={tone === 'danger' ? styles.dangerBtn : styles.primaryBtn}
                            onClick={onConfirm}
                            disabled={loading}
                        >
                            {loading ? (
                                <>
                                    <FaSpinner className={styles.spinnerSm} aria-hidden="true" />
                                    Processing...
                                </>
                            ) : (
                                confirmLabel
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
