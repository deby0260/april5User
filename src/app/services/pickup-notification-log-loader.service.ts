import { Injectable, OnDestroy } from '@angular/core';
import { Firestore, collection, query, where, getDocs, onSnapshot } from '@angular/fire/firestore';
import { BehaviorSubject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { OfflineCacheKeys, OfflineCacheService } from './offline-cache.service';

/**
 * Segment of a notification title — used so the template can render names
 * in `<strong>` without resorting to `[innerHTML]` (which would force us to
 * trust user-supplied strings).
 */
export interface PickupLogTitlePart {
  text: string;
  bold: boolean;
}

/** Row shape for Pick Up Log (matches notification-log page). */
export interface PickupLogNotificationRow {
  id: string;
  time: string;
  date?: string;
  title: string;
  /**
   * Ordered segments that compose `title`. Names (children, fetcher) are
   * marked `bold: true`; surrounding connective text stays regular weight.
   * Falls back to a single-segment array if a writer hasn't built parts.
   */
  titleParts: PickupLogTitlePart[];
  subtitle: string;
  childName: string;
  fetcherName: string;
  completedBy: string;
  scheduleTime?: string;
  scheduleId?: string;
  createdAt: any;
  type: string;
  message?: string;
  source?: 'notification' | 'scan_event';
  scanAction?: 'Entered' | 'Exited';
  scanEventDocId?: string;
}

const DISMISSED_SCAN_IDS_KEY = 'fetchsafe-notification-log-dismissed-scan-ids';
const DISMISSED_PICKUP_SCHEDULE_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-schedule-ids';
const DISMISSED_PICKUP_DOC_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-doc-ids';

/**
 * Loads and merges Pick Up Log rows (Firestore pickup_completion + ScanEvents).
 * Started in the background while the user browses the app so the Pick Up Log
 * page can render cached data immediately.
 */
@Injectable({ providedIn: 'root' })
export class PickupNotificationLogLoaderService implements OnDestroy {
  readonly rows$ = new BehaviorSubject<PickupLogNotificationRow[]>([]);
  readonly fromOfflineCache$ = new BehaviorSubject<boolean>(false);

  private familyName: string | null = null;
  private unsubs: Array<() => void> = [];
  private debounceSub: Subscription | null = null;
  private readonly refreshTrigger$ = new BehaviorSubject<void>(undefined);
  private started = false;

  constructor(
    private firestore: Firestore,
    private offlineCache: OfflineCacheService
  ) {}

  ngOnDestroy(): void {
    this.stop();
  }

  stop(): void {
    this.started = false;
    this.familyName = null;
    if (this.debounceSub) {
      this.debounceSub.unsubscribe();
      this.debounceSub = null;
    }
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* noop */
      }
    }
    this.unsubs = [];
  }

  /**
   * Attach realtime listeners for the family’s pickup log sources and keep `rows$` fresh.
   * Idempotent per `familyName`.
   */
  start(familyName: string): void {
    const name = String(familyName || '').trim();
    if (!name) {
      this.stop();
      return;
    }
    if (this.started && this.familyName === name) {
      void this.loadMerged(name);
      return;
    }
    this.stop();
    this.familyName = name;
    this.started = true;

    const notificationsCollection = collection(this.firestore, 'Notifications');
    const qPickups = query(
      notificationsCollection,
      where('type', '==', 'pickup_completion'),
      where('familyName', '==', name)
    );
    const eventsCol = collection(this.firestore, 'ScanEvents');
    const qScans = query(eventsCol, where('familyName', '==', name));

    this.debounceSub = this.refreshTrigger$
      .pipe(debounceTime(200))
      .subscribe(() => void this.loadMerged(name));

    this.unsubs.push(
      onSnapshot(qPickups, () => this.refreshTrigger$.next(), () => {})
    );
    this.unsubs.push(
      onSnapshot(qScans, () => this.refreshTrigger$.next(), () => {})
    );

    void this.loadMerged(name);
  }

  /** One-shot refresh (e.g. after dismiss or createMissing logs). */
  async refreshNow(familyName: string): Promise<void> {
    await this.loadMerged(String(familyName || '').trim());
  }

  private loadDismissedScanIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_SCAN_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  private loadDismissedPickupScheduleIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_PICKUP_SCHEDULE_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  private loadDismissedPickupDocIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_PICKUP_DOC_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  private toLocalYmd(timestamp: any): string {
    if (!timestamp) return '';
    try {
      const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      if (Number.isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    } catch {
      return '';
    }
  }

  private scheduleDateYmdFromFirestore(val: any): string {
    if (val == null) return '';
    if (typeof val === 'string') {
      const parts = val.split('-').map((n) => parseInt(n, 10));
      if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
        const [y, mo, d] = parts;
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      const d = new Date(val);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      return '';
    }
    if (typeof val.toDate === 'function') {
      const d = val.toDate();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return '';
  }

  private displayNameFromScan(data: {
    authorizerName?: string | null;
    authorizerEmail?: string | null;
    authorizerUid?: string | null;
  }): string {
    const name = String(data.authorizerName || '').trim();
    if (name) return name;
    const email = String(data.authorizerEmail || '').trim();
    if (email) return email;
    const uid = String(data.authorizerUid || '').trim();
    if (uid) return uid;
    return 'Pickup person';
  }

  private async loadScheduledChildNamesIndex(
    familyName: string
  ): Promise<Map<string, { pending: string[]; completed: string[] }>> {
    const idx = new Map<string, { pending: string[]; completed: string[] }>();
    if (!familyName) return idx;
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const snap = await getDocs(
      query(schedulesCollection, where('Family Name', '==', familyName))
    );
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const ymd = this.scheduleDateYmdFromFirestore(d['Date']);
      const fetcherUid = String(d['Fetcher UID'] || '').trim();
      const child = String(d['Childs Name'] || '').trim();
      if (!ymd || !fetcherUid || !child) return;
      const key = `${ymd}|${fetcherUid}`;
      const bucket = idx.get(key) || { pending: [], completed: [] };
      const status = (d['Status'] as string) || 'pending';
      if (status === 'pending') {
        bucket.pending.push(child);
      } else if (status === 'completed') {
        bucket.completed.push(child);
      }
      idx.set(key, bucket);
    });
    return idx;
  }

  private resolveScheduledChildNamesFromIndex(
    index: Map<string, { pending: string[]; completed: string[] }>,
    authorizerUid: string,
    scannedAt: any
  ): string[] {
    const scanYmd = this.toLocalYmd(scannedAt);
    if (!scanYmd || !authorizerUid) return [];
    const bucket = index.get(`${scanYmd}|${authorizerUid}`);
    if (!bucket) return [];
    const pick = bucket.pending.length > 0 ? bucket.pending : bucket.completed;
    return [...new Set(pick)].sort((a, b) => a.localeCompare(b));
  }

  private scanTimeMs(scannedAt: any): number {
    if (!scannedAt) return 0;
    if (typeof scannedAt.toMillis === 'function') return scannedAt.toMillis();
    if (typeof scannedAt.toDate === 'function') return scannedAt.toDate().getTime();
    const d = new Date(scannedAt as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  formatTime(timestamp: any): string {
    if (!timestamp) return 'Unknown';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return 'Unknown';
    }
  }

  private formatStoredClockTo12h(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return s;
    let h = parseInt(m[1], 10);
    const min = m[2];
    if (Number.isNaN(h) || h < 0 || h > 23) return s;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${min} ${ampm}`;
  }

  private async loadScanEventNotifications(familyName: string): Promise<PickupLogNotificationRow[]> {
    const dismissed = this.loadDismissedScanIds();
    try {
      const eventsCol = collection(this.firestore, 'ScanEvents');
      const [snap, scheduleIndex] = await Promise.all([
        getDocs(query(eventsCol, where('familyName', '==', familyName))),
        this.loadScheduledChildNamesIndex(familyName),
      ]);

      type RawScan = {
        docId: string;
        action: 'Entered' | 'Exited';
        authorizerUid: string;
        who: string;
        scannedAt: any;
      };

      const raws: RawScan[] = [];
      for (const docSnap of snap.docs) {
        if (dismissed.has(docSnap.id)) continue;
        const data = docSnap.data() as {
          action?: string;
          authorizerName?: string | null;
          authorizerEmail?: string | null;
          authorizerUid?: string | null;
          scannedAt?: any;
        };
        const action = data.action === 'Exited' ? 'Exited' : data.action === 'Entered' ? 'Entered' : null;
        if (!action) continue;
        raws.push({
          docId: docSnap.id,
          action,
          authorizerUid: String(data.authorizerUid || '').trim(),
          who: this.displayNameFromScan(data),
          scannedAt: data.scannedAt,
        });
      }
      raws.sort((a, b) => this.scanTimeMs(a.scannedAt) - this.scanTimeMs(b.scannedAt));

      const out: PickupLogNotificationRow[] = [];

      for (const row of raws) {
        const { docId, action, authorizerUid, who, scannedAt } = row;
        let title: string;
        let subtitle: string;
        let childName = '';
        // Tracks plurality across both branches so the message ternary below
        // (rendered for the detail modal) can pick was/were correctly.
        let childCount = 0;
        let titleParts: PickupLogTitlePart[] = [];

        const arrivalTimeLabel = this.formatTime(scannedAt);

        if (action === 'Entered') {
          const children = this.resolveScheduledChildNamesFromIndex(
            scheduleIndex,
            authorizerUid,
            scannedAt
          );
          childName = children.join(', ');
          childCount = children.length;
          title = `${who} has arrived at the school at ${arrivalTimeLabel}`;
          // Only the fetcher name is bolded; the surrounding connective
          // copy + time read as a normal sentence.
          titleParts = [
            { text: who, bold: true },
            { text: ` has arrived at the school at ${arrivalTimeLabel}`, bold: false },
          ];
          if (children.length === 1) {
            subtitle = `To pick up ${children[0]}`;
          } else if (children.length > 1) {
            subtitle = `To pick up ${children.join(', ')}`;
          } else {
            subtitle = 'Arrival recorded';
          }
        } else {
          const children = this.resolveScheduledChildNamesFromIndex(
            scheduleIndex,
            authorizerUid,
            scannedAt
          );
          childName = children.join(', ');
          childCount = children.length;
          const exitTimeLabel = this.formatTime(scannedAt);
          const exitSubtitle = `Exited at ${exitTimeLabel} at the school`;

          // New wording: "<children> was/were picked up by <fetcher>" — lead
          // with the kid so the parent immediately sees who left the school.
          if (children.length === 1) {
            title = `${children[0]} was picked up by ${who}`;
            titleParts = [
              { text: children[0], bold: true },
              { text: ' was picked up by ', bold: false },
              { text: who, bold: true },
            ];
            subtitle = exitSubtitle;
          } else if (children.length > 1) {
            title = `${children.join(', ')} were picked up by ${who}`;
            // Bold each child name individually so the comma separators
            // stay regular weight ("A, B, C were picked up by Fetcher").
            const parts: PickupLogTitlePart[] = [];
            children.forEach((c, i) => {
              if (i > 0) parts.push({ text: ', ', bold: false });
              parts.push({ text: c, bold: true });
            });
            parts.push({ text: ' were picked up by ', bold: false });
            parts.push({ text: who, bold: true });
            titleParts = parts;
            subtitle = exitSubtitle;
          } else {
            title = `${who} has left the school`;
            titleParts = [
              { text: who, bold: true },
              { text: ' has left the school', bold: false },
            ];
            subtitle = `${exitSubtitle}. No matching pickup was found for this person today. Confirm the schedule date and fetcher.`;
          }
        }

        out.push({
          id: `scan_${docId}`,
          time: this.formatTime(scannedAt),
          title,
          titleParts,
          subtitle,
          childName: childName || '—',
          fetcherName: who,
          completedBy: who,
          createdAt: scannedAt || new Date(0),
          type: 'building_scan',
          source: 'scan_event',
          scanAction: action,
          scanEventDocId: docId,
          message:
            action === 'Entered'
              ? childName && childName !== '—'
                ? `${who} has arrived at the school at ${arrivalTimeLabel} to pick up ${childName}.`
                : `${who} has arrived at the school at ${arrivalTimeLabel}.`
              : childName && childName !== '—'
                ? childCount > 1
                  ? `${childName} were picked up by ${who} at ${arrivalTimeLabel}.`
                  : `${childName} was picked up by ${who} at ${arrivalTimeLabel}.`
                : `${who} exited the school at ${arrivalTimeLabel}.`,
        });
      }

      return out;
    } catch {
      return [];
    }
  }

  private notificationSortTime(n: PickupLogNotificationRow): number {
    try {
      const d = n.createdAt?.toDate ? n.createdAt.toDate() : new Date(n.createdAt);
      const t = d.getTime();
      return Number.isNaN(t) ? 0 : t;
    } catch {
      return 0;
    }
  }

  private pickupCompletionMatchesExitScan(
    p: PickupLogNotificationRow,
    e: PickupLogNotificationRow
  ): boolean {
    const dayP = this.toLocalYmd(p.createdAt);
    const dayE = this.toLocalYmd(e.createdAt);
    if (!dayP || !dayE || dayP !== dayE) {
      return false;
    }
    const fetcherP = (p.completedBy || p.fetcherName || '').trim().toLowerCase();
    const fetcherE = (e.fetcherName || e.completedBy || '').trim().toLowerCase();
    if (!fetcherP || !fetcherE || fetcherP !== fetcherE) {
      return false;
    }
    const childP = (p.childName || '').trim().toLowerCase();
    if (!childP) {
      return true;
    }
    const childE = (e.childName || '').trim().toLowerCase();
    if (!childE || childE === '—') {
      return true;
    }
    const names = childE.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return names.includes(childP) || childE === childP;
  }

  private hidePickupCompletionDuplicatedByExitScan(
    items: PickupLogNotificationRow[]
  ): PickupLogNotificationRow[] {
    const exitScans = items.filter((n) => n.source === 'scan_event' && n.scanAction === 'Exited');
    return items.filter((n) => {
      if (n.source !== 'notification' || n.type !== 'pickup_completion') {
        return true;
      }
      const redundant = exitScans.some((e) => this.pickupCompletionMatchesExitScan(n, e));
      return !redundant;
    });
  }

  private async loadMerged(familyName: string): Promise<void> {
    const cacheKey = OfflineCacheKeys.pickupLog(familyName);
    try {
      const result = await this.offlineCache.loadWithOfflineFallback(cacheKey, () =>
        this.fetchMergedRows(familyName)
      );
      this.fromOfflineCache$.next(result.fromCache);
      this.rows$.next(result.data);
      return;
    } catch {
      const cached = this.offlineCache.load<PickupLogNotificationRow[]>(cacheKey);
      if (cached?.length) {
        this.fromOfflineCache$.next(true);
        this.offlineCache.setBannerActive(true);
        this.rows$.next(cached);
        return;
      }
      this.fromOfflineCache$.next(false);
      this.rows$.next([]);
    }
  }

  private async fetchMergedRows(familyName: string): Promise<PickupLogNotificationRow[]> {
    try {
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const q = query(
        notificationsCollection,
        where('type', '==', 'pickup_completion'),
        where('familyName', '==', familyName)
      );

      const querySnapshot = await getDocs(q);
      const allNotifications: PickupLogNotificationRow[] = [];
      const dismissedSchedules = this.loadDismissedPickupScheduleIds();
      const dismissedDocIds = this.loadDismissedPickupDocIds();

      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data() as any;

        if (dismissedDocIds.has(docSnap.id)) {
          return;
        }
        const sid = data['scheduleId'] != null ? String(data['scheduleId']).trim() : '';
        if (sid && dismissedSchedules.has(sid)) {
          return;
        }

        const scheduleTime = data['scheduleTime'] || '';
        const scheduleTimeLabel = this.formatStoredClockTo12h(scheduleTime);

        const completedBy = data['fetcherName'] || data['completedBy'] || 'Unknown';
        const childLabel = data['childName'] || 'Child';

        const notification: PickupLogNotificationRow = {
          id: docSnap.id,
          time: this.formatTime(data['createdAt']),
          // New wording: "<child> was picked up by <fetcher>" + scheduled time in subtitle.
          title: `${childLabel} was picked up by ${completedBy}`,
          // Only the names render bold in the inbox (template uses titleParts).
          titleParts: [
            { text: String(childLabel), bold: true },
            { text: ' was picked up by ', bold: false },
            { text: String(completedBy), bold: true },
          ],
          subtitle: scheduleTime
            ? `Scheduled for ${scheduleTimeLabel}`
            : 'Pickup completed',
          childName: data['childName'] || 'Unknown Child',
          fetcherName: data['fetcherName'] || 'Unknown Fetcher',
          completedBy: completedBy,
          scheduleTime: scheduleTime,
          scheduleId: sid || undefined,
          createdAt: data['createdAt'],
          type: data['type'],
          message: typeof data['message'] === 'string' ? data['message'] : undefined,
          source: 'notification',
        };
        allNotifications.push(notification);
      });

      const scanItems = await this.loadScanEventNotifications(familyName);
      allNotifications.push(...scanItems);

      const merged = this.hidePickupCompletionDuplicatedByExitScan(allNotifications);

      merged.sort((a, b) => {
        const dateA = this.notificationSortTime(a);
        const dateB = this.notificationSortTime(b);
        return dateB - dateA;
      });

      return merged;
    } catch {
      return [];
    }
  }
}
