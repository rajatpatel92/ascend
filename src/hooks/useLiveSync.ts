'use client';

import { useEffect, useRef } from 'react';
import {
    subscribeLiveSync,
    type LiveSyncEvent,
    type LiveSyncEventType,
} from '@/lib/live-sync';

export interface UseLiveSyncOptions {
    enabled?: boolean;
    events?: LiveSyncEventType[];
    onSync: (reason: string, event?: LiveSyncEvent) => void;
    revalidateOnFocus?: boolean;
    revalidateOnReconnect?: boolean;
    minFocusDebounceMs?: number;
    revalidateIntervalMs?: number | null;
}

const DEFAULT_FOCUS_DEBOUNCE_MS = 15_000;
const DEFAULT_REVALIDATE_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_DATA_SYNC_EVENTS: LiveSyncEventType[] = [
    'MARKET_SYNCED',
    'PORTFOLIO_UPDATED',
    'ACTIVITIES_CHANGED',
];

export function useLiveSync({
    enabled = true,
    events,
    onSync,
    revalidateOnFocus = true,
    revalidateOnReconnect = true,
    minFocusDebounceMs = DEFAULT_FOCUS_DEBOUNCE_MS,
    revalidateIntervalMs = DEFAULT_REVALIDATE_INTERVAL_MS,
}: UseLiveSyncOptions): void {
    const onSyncRef = useRef(onSync);
    const eventsRef = useRef(events);
    const lastTriggerAtRef = useRef<number>(0);

    useEffect(() => {
        onSyncRef.current = onSync;
    }, [onSync]);

    useEffect(() => {
        eventsRef.current = events;
    }, [events]);

    useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        lastTriggerAtRef.current = Date.now();

        const isOnline = (): boolean =>
            typeof navigator === 'undefined' || navigator.onLine !== false;

        const isVisible = (): boolean =>
            typeof document === 'undefined' || document.visibilityState === 'visible';

        const trigger = (reason: string, force = false, event?: LiveSyncEvent) => {
            if (!isOnline() && reason !== 'event') return;

            const now = Date.now();
            if (!force && now - lastTriggerAtRef.current < minFocusDebounceMs) {
                return;
            }

            lastTriggerAtRef.current = now;
            onSyncRef.current(reason, event);
        };

        const unsubscribe = subscribeLiveSync((event) => {
            const watched =
                eventsRef.current && eventsRef.current.length > 0
                    ? eventsRef.current
                    : DEFAULT_DATA_SYNC_EVENTS;
            if (!watched.includes(event.type)) {
                return;
            }
            trigger(`event:${event.type}`, true, event);
        });

        const handleVisibilityChange = () => {
            if (isVisible()) {
                trigger('visibility');
            }
        };

        const handleFocus = () => {
            if (isVisible()) {
                trigger('focus');
            }
        };

        const handleOnline = () => {
            // Reconnects should revalidate even shortly after prior focus if >2s elapsed
            const elapsed = Date.now() - lastTriggerAtRef.current;
            if (elapsed >= 2_000) {
                trigger('online', true);
            }
        };

        if (revalidateOnFocus) {
            document.addEventListener('visibilitychange', handleVisibilityChange);
            window.addEventListener('focus', handleFocus);
        }

        if (revalidateOnReconnect) {
            window.addEventListener('online', handleOnline);
        }

        const intervalId =
            revalidateIntervalMs && revalidateIntervalMs > 0
                ? window.setInterval(() => {
                      if (isVisible()) {
                          trigger('interval');
                      }
                  }, revalidateIntervalMs)
                : null;

        return () => {
            unsubscribe();
            if (revalidateOnFocus) {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                window.removeEventListener('focus', handleFocus);
            }
            if (revalidateOnReconnect) {
                window.removeEventListener('online', handleOnline);
            }
            if (intervalId !== null) {
                window.clearInterval(intervalId);
            }
        };
    }, [enabled, minFocusDebounceMs, revalidateIntervalMs, revalidateOnFocus, revalidateOnReconnect]);
}
