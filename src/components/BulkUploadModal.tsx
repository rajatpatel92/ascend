/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useRef } from 'react';
import { FaCloudUploadAlt, FaCheckCircle, FaSpinner, FaTimes } from 'react-icons/fa';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import modalStyles from './ActivitiesModal.module.css';
import styles from './BulkUploadModal.module.css';

interface BulkUploadModalProps {
    onClose: () => void;
    onSuccess: (importedCount?: number) => void;
}

type Step = 'UPLOAD' | 'VALIDATING' | 'REVIEW' | 'IMPORTING' | 'SUCCESS';

const CSV_COLUMNS = [
    'Date',
    'Type',
    'Symbol',
    'Quantity',
    'Price',
    'Fee',
    'Currency',
    'Username',
    'Account Type',
    'Platform'
];

export default function BulkUploadModal({ onClose, onSuccess }: BulkUploadModalProps) {
    const [step, setStep] = useState<Step>('UPLOAD');
    const [file, setFile] = useState<File | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const [validationResult, setValidationResult] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const isBusy = step === 'VALIDATING' || step === 'IMPORTING';

    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen: true,
        onClose,
        disabled: isBusy
    });

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setError(null);
        }
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) {
            if (!dropped.name.toLowerCase().endsWith('.csv') && dropped.type !== 'text/csv') {
                setError('Please drop a valid .csv file.');
                return;
            }
            setFile(dropped);
            setError(null);
        }
    };

    const handleUpload = async () => {
        if (!file) return;

        setStep('VALIDATING');
        setError(null);

        try {
            const text = await file.text();

            const res = await fetch('/api/activities/import/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ csvContent: text })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Validation failed');
            }

            setValidationResult(data);
            setStep('REVIEW');
        } catch (err: any) {
            setError(err.message);
            setStep('UPLOAD');
        }
    };

    const handleImport = async () => {
        if (!validationResult || !validationResult.valid) return;

        setStep('IMPORTING');
        setError(null);

        try {
            const res = await fetch('/api/activities/import/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activities: validationResult.data })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Import failed');
            }

            setStep('SUCCESS');
        } catch (err: any) {
            setError(err.message);
            setStep('REVIEW');
        }
    };

    const validRows = Array.isArray(validationResult?.data) ? validationResult.data : [];
    const errorRows = Array.isArray(validationResult?.errors) ? validationResult.errors : [];
    const totalRows = validationResult?.totalRows ?? validRows.length + errorRows.length;

    return (
        <div
            className={modalStyles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${modalStyles.modal} ${modalStyles.modalMd}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-upload-title"
            >
                <div className={modalStyles.header}>
                    <div className={modalStyles.headerTitleGroup}>
                        <span className={modalStyles.headerIcon} aria-hidden="true">
                            <FaCloudUploadAlt />
                        </span>
                        <div className={modalStyles.headerText}>
                            <h2 id="bulk-upload-title" className={modalStyles.title}>
                                Import Activities CSV
                            </h2>
                            <p className={modalStyles.subtitle}>
                                Upload and validate bulk transactions before importing into your ledger.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={modalStyles.closeButton}
                        onClick={onClose}
                        disabled={isBusy}
                        aria-label="Close import modal"
                    >
                        <FaTimes aria-hidden="true" />
                    </button>
                </div>

                <div className={modalStyles.body}>
                    <div className={modalStyles.stepper} aria-label="Import progress">
                        <span
                            className={`${modalStyles.stepBadge} ${
                                step === 'UPLOAD' || step === 'VALIDATING'
                                    ? modalStyles.stepActive
                                    : modalStyles.stepDone
                            }`}
                        >
                            1. Upload
                        </span>
                        <span
                            className={`${modalStyles.stepBadge} ${
                                step === 'REVIEW' || step === 'IMPORTING'
                                    ? modalStyles.stepActive
                                    : step === 'SUCCESS'
                                        ? modalStyles.stepDone
                                        : ''
                            }`}
                        >
                            2. Review
                        </span>
                        <span
                            className={`${modalStyles.stepBadge} ${
                                step === 'SUCCESS' ? modalStyles.stepDone : ''
                            }`}
                        >
                            3. Complete
                        </span>
                    </div>

                    {error && (
                        <div className={modalStyles.errorBanner} role="alert">
                            {error}
                        </div>
                    )}

                    {step === 'UPLOAD' && (
                        <>
                            <div
                                role="button"
                                tabIndex={0}
                                className={`${styles.dropZone} ${isDragOver ? styles.dropZoneActive : ''}`}
                                onClick={() => fileInputRef.current?.click()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        fileInputRef.current?.click();
                                    }
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragOver(true);
                                }}
                                onDragLeave={() => setIsDragOver(false)}
                                onDrop={handleDrop}
                            >
                                <FaCloudUploadAlt className={styles.uploadIcon} aria-hidden="true" />
                                <p className={styles.dropTitle}>Click or drag &amp; drop a CSV file</p>
                                <p className={styles.dropSubtitle}>Supports UTF-8 comma-separated exports</p>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept=".csv"
                                    style={{ display: 'none' }}
                                />
                            </div>

                            {file && (
                                <div className={styles.selectedFileCard}>
                                    <div className={styles.selectedFileMeta}>
                                        <span className={styles.fileName}>{file.name}</span>
                                        <span className={styles.fileSize}>
                                            {(file.size / 1024).toFixed(1)} KB
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className={modalStyles.ghostBtn}
                                        onClick={() => {
                                            setFile(null);
                                            if (fileInputRef.current) fileInputRef.current.value = '';
                                        }}
                                    >
                                        Remove
                                    </button>
                                </div>
                            )}

                            <div className={styles.schemaBox}>
                                <span className={styles.schemaLabel}>Expected CSV Columns</span>
                                <div className={styles.columnPills}>
                                    {CSV_COLUMNS.map((col) => (
                                        <span key={col} className={styles.columnPill}>
                                            {col}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {step === 'VALIDATING' && (
                        <div className={modalStyles.loadingState}>
                            <FaSpinner className={modalStyles.spinner} aria-hidden="true" />
                            <p style={{ margin: 0 }}>Validating symbols, accounts, and dates...</p>
                        </div>
                    )}

                    {step === 'REVIEW' && validationResult && (
                        <>
                            <div className={styles.summaryGrid}>
                                <div className={styles.statCard}>
                                    <span className={styles.statLabel}>Total Rows</span>
                                    <span className={styles.statValue}>{totalRows}</span>
                                </div>
                                <div className={styles.statCard}>
                                    <span className={styles.statLabel}>Valid</span>
                                    <span className={`${styles.statValue} ${styles.statPositive}`}>
                                        {validRows.length}
                                    </span>
                                </div>
                                <div className={styles.statCard}>
                                    <span className={styles.statLabel}>Errors</span>
                                    <span
                                        className={`${styles.statValue} ${
                                            errorRows.length > 0 ? styles.statDanger : ''
                                        }`}
                                    >
                                        {errorRows.length}
                                    </span>
                                </div>
                            </div>

                            {errorRows.length > 0 ? (
                                <div className={styles.errorList}>
                                    <h3 className={styles.errorListTitle}>Validation Errors</h3>
                                    <ul>
                                        {errorRows.map((err: any, i: number) => (
                                            <li key={i}>
                                                <strong>Row {err.row}:</strong> {err.message}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : (
                                <>
                                    <div className={modalStyles.successBanner}>
                                        <FaCheckCircle aria-hidden="true" />
                                        <span>
                                            All {validRows.length} row(s) passed validation and are ready to import.
                                        </span>
                                    </div>
                                    {validRows.length > 0 && (
                                        <div className={modalStyles.tableWrap}>
                                            <table className={modalStyles.modalTable}>
                                                <thead>
                                                    <tr>
                                                        <th>Date</th>
                                                        <th>Symbol</th>
                                                        <th>Type</th>
                                                        <th style={{ textAlign: 'right' }}>Qty</th>
                                                        <th style={{ textAlign: 'right' }}>Price</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {validRows.slice(0, 5).map((r: any, idx: number) => (
                                                        <tr key={idx}>
                                                            <td>{r.Date}</td>
                                                            <td style={{ fontWeight: 700 }}>{r.Symbol}</td>
                                                            <td>{r.Type}</td>
                                                            <td style={{ textAlign: 'right' }}>{r.Quantity}</td>
                                                            <td style={{ textAlign: 'right' }}>{r.Price}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                    {validRows.length > 5 && (
                                        <p className={modalStyles.fieldHint} style={{ textAlign: 'center' }}>
                                            Showing first 5 of {validRows.length} validated rows.
                                        </p>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {step === 'IMPORTING' && (
                        <div className={modalStyles.loadingState}>
                            <FaSpinner className={modalStyles.spinner} aria-hidden="true" />
                            <p style={{ margin: 0 }}>Importing {validRows.length} activities...</p>
                        </div>
                    )}

                    {step === 'SUCCESS' && (
                        <div className={styles.successState}>
                            <FaCheckCircle className={styles.successIcon} aria-hidden="true" />
                            <h3 className={styles.successTitle}>Import Successful</h3>
                            <p className={styles.successText}>
                                Added {validRows.length} activities to your portfolio ledger.
                            </p>
                        </div>
                    )}
                </div>

                {!isBusy && (
                    <div className={modalStyles.footer}>
                        {step === 'REVIEW' && (
                            <button
                                type="button"
                                className={modalStyles.secondaryBtn}
                                onClick={() => setStep('UPLOAD')}
                            >
                                Choose Another File
                            </button>
                        )}
                        <div className={modalStyles.footerEnd}>
                            {step !== 'SUCCESS' && (
                                <button
                                    type="button"
                                    className={modalStyles.secondaryBtn}
                                    onClick={onClose}
                                >
                                    Cancel
                                </button>
                            )}
                            {step === 'UPLOAD' && (
                                <button
                                    type="button"
                                    className={modalStyles.primaryBtn}
                                    disabled={!file}
                                    onClick={handleUpload}
                                >
                                    Validate &amp; Review
                                </button>
                            )}
                            {step === 'REVIEW' && errorRows.length === 0 && (
                                <button
                                    type="button"
                                    className={modalStyles.primaryBtn}
                                    onClick={handleImport}
                                >
                                    Import {validRows.length} Activities
                                </button>
                            )}
                            {step === 'SUCCESS' && (
                                <button
                                    type="button"
                                    className={modalStyles.primaryBtn}
                                    onClick={() => {
                                        onSuccess(validRows.length);
                                        onClose();
                                    }}
                                >
                                    Done
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
