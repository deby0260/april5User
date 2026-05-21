import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Central keys for localStorage snapshots (prefix `fetchsafe-offline:` added internally). */
export const OfflineCacheKeys = {
  pickupLog: (familyName: string) => `pickup-log:${familyName}`,
  inbox: (uid: string) => `inbox:${uid}`,
  homePickups: (familyName: string) => `home-pickups:${familyName}`,
  schedules: (familyName: string) => `schedules:${familyName}`,
  family: (familyName: string) => `family:${familyName}`,
  qr: (uid: string) => `qr:${uid}`,
} as const;

const STORAGE_PREFIX = 'fetchsafe-offline:';
const LEGACY_QR_KEY = 'fetchsafe_qr_data_v2';

type TimestampLike = {
  toDate?: () => Date;
  toMillis?: () => number;
  seconds?: number;
};

@Injectable({ providedIn: 'root' })
export class OfflineCacheService {
  /** Global banner: any screen is showing a saved snapshot. */
  readonly bannerActive$ = new BehaviorSubject<boolean>(false);

  private online$ = new BehaviorSubject<boolean>(this.readNavigatorOnline());

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.online$.next(true);
        this.bannerActive$.next(false);
      });
      window.addEventListener('offline', () => this.online$.next(false));
    }
  }

  onlineChanges$ = this.online$.asObservable();

  isOnline(): boolean {
    return this.readNavigatorOnline();
  }

  setBannerActive(active: boolean): void {
    this.bannerActive$.next(active);
  }

  save<T>(key: string, data: T): void {
    try {
      const payload = {
        cachedAt: new Date().toISOString(),
        data: this.serializeForCache(data),
      };
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(payload));
    } catch {
      /* quota or private mode */
    }
  }

  load<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { data?: T };
      if (parsed?.data === undefined) {
        return null;
      }
      return this.deserializeFromCache(parsed.data) as T;
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return !!localStorage.getItem(STORAGE_PREFIX + key);
  }

  remove(key: string): void {
    localStorage.removeItem(STORAGE_PREFIX + key);
  }

  /**
   * Online: run loader, save snapshot, clear banner.
   * Offline or failed network: return last snapshot if present.
   */
  async loadWithOfflineFallback<T>(
    key: string,
    loader: () => Promise<T>
  ): Promise<{ data: T; fromCache: boolean }> {
    if (this.isOnline()) {
      try {
        const data = await loader();
        this.save(key, data);
        return { data, fromCache: false };
      } catch {
        const cached = this.load<T>(key);
        if (cached != null) {
          this.setBannerActive(true);
          return { data: cached, fromCache: true };
        }
        throw new Error('Load failed and no offline cache');
      }
    }

    const cached = this.load<T>(key);
    if (cached != null) {
      this.setBannerActive(true);
      return { data: cached, fromCache: true };
    }

    const data = await loader();
    return { data, fromCache: false };
  }

  /** QR legacy payload migration + save under namespaced key. */
  saveQrPayload(uid: string, payload: Record<string, unknown>): void {
    this.save(OfflineCacheKeys.qr(uid), payload);
    try {
      localStorage.setItem(LEGACY_QR_KEY, JSON.stringify(payload));
    } catch {
      /* noop */
    }
  }

  loadQrPayload(uid: string): Record<string, unknown> | null {
    const namespaced = this.load<Record<string, unknown>>(OfflineCacheKeys.qr(uid));
    if (namespaced) {
      return namespaced;
    }
    try {
      const legacy = localStorage.getItem(LEGACY_QR_KEY);
      if (!legacy) {
        return null;
      }
      const parsed = JSON.parse(legacy) as Record<string, unknown>;
      if (parsed?.['userId'] === uid) {
        this.saveQrPayload(uid, parsed);
        return parsed;
      }
    } catch {
      /* noop */
    }
    return null;
  }

  clearQrPayload(uid: string): void {
    this.remove(OfflineCacheKeys.qr(uid));
    localStorage.removeItem(LEGACY_QR_KEY);
  }

  private readNavigatorOnline(): boolean {
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  private serializeForCache(value: unknown): unknown {
    if (value == null) {
      return value;
    }
    const ts = value as TimestampLike;
    if (typeof ts.toDate === 'function') {
      const d = ts.toDate!();
      return { __fsTs: d.toISOString() };
    }
    if (typeof ts.toMillis === 'function') {
      return { __fsTs: new Date(ts.toMillis!()).toISOString() };
    }
    if (typeof ts.seconds === 'number') {
      return { __fsTs: new Date(ts.seconds * 1000).toISOString() };
    }
    if (value instanceof Date) {
      return { __iso: value.toISOString() };
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.serializeForCache(v));
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.serializeForCache(v);
      }
      return out;
    }
    return value;
  }

  private deserializeFromCache(value: unknown): unknown {
    if (value == null || typeof value !== 'object') {
      return value;
    }
    const o = value as Record<string, unknown>;
    if (typeof o['__fsTs'] === 'string') {
      const d = new Date(o['__fsTs']);
      return {
        toDate: () => d,
        toMillis: () => d.getTime(),
        seconds: Math.floor(d.getTime() / 1000),
      };
    }
    if (typeof o['__iso'] === 'string') {
      return new Date(o['__iso']);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.deserializeFromCache(v));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = this.deserializeFromCache(v);
    }
    return out;
  }
}
