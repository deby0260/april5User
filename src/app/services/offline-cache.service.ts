import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Central keys for localStorage snapshots (prefix `fetchsafe-offline:` added internally). */
export const OfflineCacheKeys = {
  pickupLog: (familyName: string) => `pickup-log:${familyName}`,
  inbox: (uid: string) => `inbox:${uid}`,
  homePickups: (familyName: string) => `home-pickups:${familyName}`,
  schedules: (familyName: string) => `schedules:${familyName}`,
  family: (familyName: string) => `family:${familyName}`,
  familyPage: (uid: string) => `family-page:${uid}`,
  qr: (uid: string) => `qr:${uid}`,
  userProfile: (uid: string) => `user-profile:${uid}`,
} as const;

const STORAGE_PREFIX = 'fetchsafe-offline:';
const IMAGE_MAP_KEY = 'image-url-map';
const LEGACY_QR_KEY = 'fetchsafe_qr_data_v2';
const MAX_OFFLINE_IMAGE_BYTES = 800_000;
const OFFLINE_IMAGE_REF_PREFIX = '__offlineImg:';
const PROFILE_IMAGE_FIELDS = new Set([
  'profilePicture',
  'parentProfilePicture',
  'Parent Profile Picture',
  'Fetchers Profile',
  'Child Profile Picture',
  'childProfilePicture',
]);

type TimestampLike = {
  toDate?: () => Date;
  toMillis?: () => number;
  seconds?: number;
};

@Injectable({ providedIn: 'root' })
export class OfflineCacheService {
  /** True when the device has no network (navigator.onLine). */
  readonly offlineMode$ = new BehaviorSubject<boolean>(!this.readNavigatorOnline());
  /** True when showing a saved data snapshot (may also be offline). */
  readonly bannerActive$ = new BehaviorSubject<boolean>(false);

  private online$ = new BehaviorSubject<boolean>(this.readNavigatorOnline());

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.online$.next(true);
        this.offlineMode$.next(false);
        this.bannerActive$.next(false);
      });
      window.addEventListener('offline', () => {
        this.online$.next(false);
        this.offlineMode$.next(true);
        this.bannerActive$.next(true);
      });
    }
  }

  onlineChanges$ = this.online$.asObservable();

  isOfflineMode(): boolean {
    return !this.isOnline();
  }

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
        await this.prefetchProfileImagesForOffline(data);
        this.save(key, this.stripProfileImagesForStorage(data));
        return { data, fromCache: false };
      } catch {
        const cached = this.load<T>(key);
        if (cached != null) {
          this.setBannerActive(true);
          return { data: this.applyOfflineProfileImages(cached), fromCache: true };
        }
        throw new Error('Load failed and no offline cache');
      }
    }

    const cached = this.load<T>(key);
    if (cached != null) {
      this.setBannerActive(true);
      return { data: this.applyOfflineProfileImages(cached), fromCache: true };
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

  /** Cache profile photo for Settings / session (data URL survives offline). */
  async cacheUserProfilePicture(uid: string, profilePicture?: string): Promise<void> {
    const id = String(uid || '').trim();
    const src = String(profilePicture || '').trim();
    if (!id || !src) {
      return;
    }
    const ref = await this.storeImageForOffline(src);
    const resolved = this.resolveImageString(ref);
    this.save(OfflineCacheKeys.userProfile(id), { profilePicture: resolved || ref });
  }

  /** Use cached data URL for the signed-in user when offline. */
  resolveUserProfileForDisplay<T extends { uid?: string; profilePicture?: string }>(
    user: T | null
  ): T | null {
    if (!user?.uid) {
      return user;
    }
    const cached = this.load<{ profilePicture?: string }>(OfflineCacheKeys.userProfile(user.uid));
    const offlinePic = this.resolveImageString(String(cached?.profilePicture || '').trim());
    if (!offlinePic || this.isOnline()) {
      return user;
    }
    return { ...user, profilePicture: offlinePic };
  }

  /** Download / register images in the sidecar map (family JSON stays small). */
  async prefetchProfileImagesForOffline<T>(value: T): Promise<void> {
    await this.walkProfileImages(value, async (src) => {
      await this.storeImageForOffline(src);
    });
  }

  /** Replace profile image strings with short refs before writing localStorage. */
  stripProfileImagesForStorage<T>(value: T): T {
    return this.mapProfileImages(value, (src) => {
      const ref = this.imageRefKey(src);
      const map = this.loadImageMap();
      if (map[ref] || map[src]) {
        return ref;
      }
      return src;
    });
  }

  /** Resolve refs / http URLs to data URLs for offline UI. */
  applyOfflineProfileImages<T>(value: T): T {
    return this.mapProfileImages(value, (src) => this.resolveImageString(src));
  }

  private isProfileImageField(key: string, value: unknown): boolean {
    if (typeof value !== 'string' || !value.trim()) {
      return false;
    }
    if (PROFILE_IMAGE_FIELDS.has(key)) {
      return true;
    }
    return this.looksLikeImageUrl(value);
  }

  private looksLikeImageUrl(value: string): boolean {
    const s = value.trim();
    if (s.startsWith('data:image/')) {
      return true;
    }
    if (!/^https?:\/\//i.test(s)) {
      return false;
    }
    return (
      /firebasestorage|googleapis|firebase/i.test(s) ||
      /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(s)
    );
  }

  private imageRefKey(src: string): string {
    let h = 0;
    const s = src.trim();
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return `${OFFLINE_IMAGE_REF_PREFIX}${Math.abs(h).toString(36)}_${s.length}`;
  }

  private resolveImageString(src: string): string {
    const s = String(src || '').trim();
    if (!s) {
      return '';
    }
    if (s.startsWith('data:image/')) {
      return s;
    }
    if (s.startsWith(OFFLINE_IMAGE_REF_PREFIX)) {
      return this.loadImageMapEntry(s) || '';
    }
    const byUrl = this.loadImageMapEntry(s);
    if (byUrl) {
      return byUrl;
    }
    return s;
  }

  private async storeImageForOffline(src: string): Promise<string> {
    const original = String(src || '').trim();
    if (!original) {
      return '';
    }
    const ref = this.imageRefKey(original);
    const existing = this.loadImageMapEntry(ref) || this.loadImageMapEntry(original);
    if (existing) {
      return ref;
    }
    let dataUrl = original;
    if (original.startsWith('data:image/')) {
      this.saveImageMapEntry(ref, original);
      this.saveImageMapEntry(original, original);
      return ref;
    }
    if (!this.isOnline()) {
      return original;
    }
    dataUrl = await this.urlToOfflineDataUrl(original);
    if (dataUrl.startsWith('data:image/')) {
      this.saveImageMapEntry(ref, dataUrl);
      this.saveImageMapEntry(original, dataUrl);
    }
    return ref;
  }

  private async walkProfileImages(
    value: unknown,
    fn: (src: string) => Promise<void>
  ): Promise<void> {
    if (value == null) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        await this.walkProfileImages(item, fn);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (this.isProfileImageField(k, v)) {
          await fn(String(v));
        } else {
          await this.walkProfileImages(v, fn);
        }
      }
    }
  }

  private mapProfileImages<T>(value: T, mapFn: (src: string) => string): T {
    if (value == null) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.mapProfileImages(item, mapFn)) as T;
    }
    if (typeof value === 'object') {
      const obj = { ...(value as Record<string, unknown>) };
      for (const [k, v] of Object.entries(obj)) {
        if (this.isProfileImageField(k, v)) {
          obj[k] = mapFn(String(v));
        } else {
          obj[k] = this.mapProfileImages(v, mapFn);
        }
      }
      return obj as T;
    }
    return value;
  }

  private async urlToOfflineDataUrl(url: string): Promise<string> {
    const src = String(url || '').trim();
    if (!src) {
      return '';
    }
    if (src.startsWith('data:image/')) {
      return src;
    }
    try {
      const res = await fetch(src, { mode: 'cors', cache: 'force-cache' });
      if (!res.ok) {
        return await this.urlToDataUrlViaImageElement(src);
      }
      const blob = await res.blob();
      if (blob.size > MAX_OFFLINE_IMAGE_BYTES) {
        return await this.compressBlobToDataUrl(blob);
      }
      return await this.blobToDataUrl(blob);
    } catch {
      return await this.urlToDataUrlViaImageElement(src);
    }
  }

  /** Fallback when fetch() is blocked (common with some storage URLs). */
  private urlToDataUrlViaImageElement(url: string): Promise<string> {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined') {
        resolve(url);
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(url), 12000);
      img.onload = () => {
        clearTimeout(t);
        try {
          const canvas = document.createElement('canvas');
          const max = 320;
          let w = img.naturalWidth || max;
          let h = img.naturalHeight || max;
          if (w > max || h > max) {
            const scale = Math.min(max / w, max / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(url);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        } catch {
          resolve(url);
        }
      };
      img.onerror = () => {
        clearTimeout(t);
        resolve(url);
      };
      img.src = url;
    });
  }

  private async compressBlobToDataUrl(blob: Blob): Promise<string> {
    try {
      const dataUrl = await this.blobToDataUrl(blob);
      return this.urlToDataUrlViaImageElement(dataUrl);
    } catch {
      return '';
    }
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(blob);
    });
  }

  private loadImageMap(): Record<string, string> {
    return this.load<Record<string, string>>(IMAGE_MAP_KEY) || {};
  }

  private loadImageMapEntry(key: string): string | null {
    const map = this.loadImageMap();
    const hit = map[key];
    return typeof hit === 'string' && hit.startsWith('data:image/') ? hit : null;
  }

  private saveImageMapEntry(url: string, dataUrl: string): void {
    const map = this.loadImageMap();
    map[url] = dataUrl;
    this.save(IMAGE_MAP_KEY, map);
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
