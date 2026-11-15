/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { FaTimes } from 'react-icons/fa';
import { MdAddCircleOutline, MdEdit } from 'react-icons/md';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import AddActivityForm from './AddActivityForm';
import styles from './ActivitiesModal.module.css';

interface ActivityFormModalProps {
    isOpen: boolean;
    initialData?: any;
    accountsRefreshKey?: number;
    onClose: () => void;
    onSuccess: (isEdit: boolean) => void;
}

export default function ActivityFormModal({
    isOpen,
    initialData,
    accountsRefreshKey,
    onClose,
    onSuccess
}: ActivityFormModalProps) {
    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen,
        onClose
    });

    if (!isOpen) return null;

    const isEditing = Boolean(initialData);
    const symbolLabel = initialData?.investment?.symbol;

    return (
        <div
            className={styles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${styles.modal} ${styles.modalLg}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="activity-modal-title"
            >
                <div className={styles.header}>
                    <div className={styles.headerTitleGroup}>
                        <span className={styles.headerIcon} aria-hidden="true">
                            {isEditing ? <MdEdit /> : <MdAddCircleOutline />}
                        </span>
                        <div className={styles.headerText}>
                            <div className={styles.titleRow}>
                                <h2 id="activity-modal-title" className={styles.title}>
                                    {isEditing ? 'Edit Activity' : 'Add Activity'}
                                </h2>
                                {isEditing && symbolLabel && (
                                    <span className={`${styles.pill} ${styles.pillInfo}`}>{symbolLabel}</span>
                                )}
                            </div>
                            <p className={styles.subtitle}>
                                {isEditing
                                    ? 'Update transaction date, quantity, price, fees, or account.'
                                    : 'Search a symbol and record a buy, sell, dividend, split, or transfer.'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={onClose}
                        aria-label="Close activity form"
                    >
                        <FaTimes aria-hidden="true" />
                    </button>
                </div>

                <AddActivityForm
                    inModal
                    initialData={initialData}
                    accountsRefreshKey={accountsRefreshKey}
                    onCancel={onClose}
                    onSuccess={() => onSuccess(isEditing)}
                />
            </div>
        </div>
    );
}
