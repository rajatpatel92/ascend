'use client';

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface ModalBehaviorOptions {
    isOpen: boolean;
    onClose: () => void;
    disabled?: boolean;
}

/**
 * Shared accessibility and interaction behavior for custom dialog overlays:
 * - Escape key closes the modal (unless disabled)
 * - Body scroll is locked while open and restored on unmount
 * - Backdrop click only closes if both pointerdown and pointerup occur on the overlay
 */
export function useModalBehavior({ isOpen, onClose, disabled = false }: ModalBehaviorOptions) {
    const pointerStartedOutsideRef = useRef(false);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;

        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !disabled) {
                event.preventDefault();
                onCloseRef.current();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = prevOverflow;
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, disabled]);

    const handleOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        pointerStartedOutsideRef.current = event.target === event.currentTarget;
    };

    const handleOverlayPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!disabled && pointerStartedOutsideRef.current && event.target === event.currentTarget) {
            onCloseRef.current();
        }
        pointerStartedOutsideRef.current = false;
    };

    return {
        handleOverlayPointerDown,
        handleOverlayPointerUp
    };
}
