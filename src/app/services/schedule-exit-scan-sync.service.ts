import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  addDoc,
  serverTimestamp,
} from '@angular/fire/firestore';
import { NotificationService } from './notification.service';

interface ScanEventRow {
  action: 'Entered' | 'Exited';
  authorizerUid: string;
  authorizerName: string;
  authorizerEmail: string;
  scannedAt: any;
}

interface SchedulePendingSnapshot {
  id: string;
  ymd: string;
  time: string;
  days: string;
  childName: string;
  fetcherUID: string;
  fetcherName: string;
  childGrade: string;
  parentName: string;
  familyName: string;
  createdAt: any;
}

interface PendingGroup {
  docIds: string[];
  ymd: string;
  fetcherUID: string;
  primary: SchedulePendingSnapshot;
  /** Min Created At across merged duplicate docs; exit must be at/after this so old scans cannot complete new schedules. */
  earliestCreatedAtMs: number;
}

/**
 * When an admin scans the fetcher QR: Entered = in building (early arrival is OK);
 * Exited after a same-day Entered = pickup done → mark matching pending Schedules completed
 * so Home / View Schedule lists drop the row.
 */
@Injectable({ providedIn: 'root' })
export class ScheduleExitScanSyncService {
  constructor(
    private firestore: Firestore,
    private notificationService: NotificationService
  ) {}

  async syncExitScansToCompletedSchedules(familyName: string): Promise<void> {
    if (!familyName?.trim()) return;
    try {
      const events = await this.loadScanEvents(familyName);
      const exits = this.exitsWithPriorEnterSameDay(events);
      if (exits.length === 0) return;

      exits.sort((a, b) => this.scanTimeMs(a.scannedAt) - this.scanTimeMs(b.scannedAt));

      let remaining = await this.loadPendingGrouped(familyName);
      if (remaining.size === 0) return;

      for (const exit of exits) {
        const exitYmd = this.toLocalYmdFromScan(exit.scannedAt);
        const exitMs = this.scanTimeMs(exit.scannedAt);
        const uid = exit.authorizerUid;
        if (!exitYmd || !uid || !exitMs) continue;

        const completedBy = this.displayNameFromScan(exit);
        const keysToRemove: string[] = [];

        for (const [key, group] of remaining) {
          if (group.ymd !== exitYmd || group.fetcherUID !== uid) continue;
          if (
            group.earliestCreatedAtMs > 0 &&
            exitMs < group.earliestCreatedAtMs
          ) {
            continue;
          }
          await this.completeGroup(group, completedBy, familyName);
          keysToRemove.push(key);
        }
        for (const k of keysToRemove) {
          remaining.delete(k);
        }
      }
    } catch (e) {
    }
  }

  private async loadScanEvents(familyName: string): Promise<ScanEventRow[]> {
    const eventsCol = collection(this.firestore, 'ScanEvents');
    const snap = await getDocs(query(eventsCol, where('familyName', '==', familyName)));
    const rows: ScanEventRow[] = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const raw = data['action'];
      const action =
        raw === 'Exited' ? 'Exited' : raw === 'Entered' ? 'Entered' : null;
      if (!action) continue;
      rows.push({
        action,
        authorizerUid: String(data['authorizerUid'] ?? '').trim(),
        authorizerName: String(data['authorizerName'] ?? ''),
        authorizerEmail: String(data['authorizerEmail'] ?? ''),
        scannedAt: data['scannedAt'],
      });
    }
    rows.sort((a, b) => this.scanTimeMs(a.scannedAt) - this.scanTimeMs(b.scannedAt));
    return rows;
  }

  private exitsWithPriorEnterSameDay(events: ScanEventRow[]): ScanEventRow[] {
    const out: ScanEventRow[] = [];
    for (const e of events) {
      if (e.action !== 'Exited') continue;
      const ymd = this.toLocalYmdFromScan(e.scannedAt);
      const exitMs = this.scanTimeMs(e.scannedAt);
      const uid = e.authorizerUid;
      if (!ymd || !uid || !exitMs) continue;

      const hasPriorEnter = events.some(
        (x) =>
          x.action === 'Entered' &&
          x.authorizerUid === uid &&
          this.toLocalYmdFromScan(x.scannedAt) === ymd &&
          this.scanTimeMs(x.scannedAt) < exitMs
      );
      if (hasPriorEnter) {
        out.push(e);
      }
    }
    return out;
  }

  private async loadPendingGrouped(familyName: string): Promise<Map<string, PendingGroup>> {
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const snap = await getDocs(
      query(schedulesCollection, where('Family Name', '==', familyName))
    );

    const items: SchedulePendingSnapshot[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data() as Record<string, unknown>;
      const status = (d['Status'] as string) || 'pending';
      if (status !== 'pending') return;

      const ymd = this.scheduleDateYmdFromFirestore(d['Date']);
      items.push({
        id: docSnap.id,
        ymd,
        time: String(d['Time'] ?? '').trim(),
        days: String(d['Days'] ?? '').trim(),
        childName: String(d['Childs Name'] ?? '').trim(),
        fetcherUID: String(d['Fetcher UID'] ?? '').trim(),
        fetcherName: String(d['Companions Name'] ?? ''),
        childGrade: String(d['Childs Grade'] ?? ''),
        parentName: String(d['Parent Name'] ?? ''),
        familyName: String(d['Family Name'] ?? familyName),
        createdAt: d['Created At'],
      });
    });

    const keyToList = new Map<string, SchedulePendingSnapshot[]>();
    for (const it of items) {
      const key = `${it.ymd}|${it.time}|${it.childName}|${it.fetcherUID}|${it.days}`;
      if (!keyToList.has(key)) keyToList.set(key, []);
      keyToList.get(key)!.push(it);
    }

    const out = new Map<string, PendingGroup>();
    for (const [key, list] of keyToList) {
      list.sort((a, b) => this.createdAtMs(b.createdAt) - this.createdAtMs(a.createdAt));
      const [primary, ...rest] = list;
      const createdTimes = list
        .map((it) => this.createdAtMs(it.createdAt))
        .filter((t) => t > 0);
      const earliestCreatedAtMs =
        createdTimes.length > 0 ? Math.min(...createdTimes) : 0;
      out.set(key, {
        docIds: [primary.id, ...rest.map((r) => r.id)],
        ymd: primary.ymd,
        fetcherUID: primary.fetcherUID,
        primary,
        earliestCreatedAtMs,
      });
    }
    return out;
  }

  private async completeGroup(
    group: PendingGroup,
    completedBy: string,
    familyName: string
  ): Promise<void> {
    const p = group.primary;
    for (const docId of group.docIds) {
      const scheduleDoc = doc(this.firestore, 'Schedules', docId);
      await updateDoc(scheduleDoc, {
        'Status': 'completed',
        'Completed At': serverTimestamp(),
        'Completed By': completedBy,
      });
    }

    const notificationsCollection = collection(this.firestore, 'Notifications');
    await addDoc(notificationsCollection, {
      type: 'pickup_completion',
      title: `${p.childName} picked up`,
      message: `${p.childName} was marked picked up when ${completedBy} exited the building.`,
      childName: p.childName,
      childGrade: p.childGrade,
      fetcherName: p.fetcherName,
      completedBy,
      familyName: p.familyName || familyName,
      scheduleId: p.id,
      scheduleDate: p.ymd,
      scheduleTime: p.time,
      scheduleDays: p.days,
      isRead: false,
      createdAt: serverTimestamp(),
    });

    await this.notificationService.sendScheduleNotification(
      'Pickup completed',
      `${p.childName} — marked picked up after building exit.`,
      familyName
    );
  }

  private toLocalYmdFromScan(timestamp: any): string {
    if (!timestamp) return '';
    try {
      const d =
        typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
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
    if (typeof val === 'string') return this.toLocalYmdFromDateString(val);
    if (typeof val.toDate === 'function') {
      const d = val.toDate();
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${day}`;
    }
    return '';
  }

  private toLocalYmdFromDateString(dateStr: string): string {
    const parts = dateStr.split('-').map((n) => parseInt(n, 10));
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const [y, m, d] = parts;
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  private scanTimeMs(scannedAt: any): number {
    if (!scannedAt) return 0;
    if (typeof scannedAt.toMillis === 'function') return scannedAt.toMillis();
    if (typeof scannedAt.toDate === 'function') return scannedAt.toDate().getTime();
    const d = new Date(scannedAt as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  private createdAtMs(v: any): number {
    if (v == null) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    return 0;
  }

  private displayNameFromScan(exit: ScanEventRow): string {
    const name = String(exit.authorizerName || '').trim();
    if (name) return name;
    const email = String(exit.authorizerEmail || '').trim();
    if (email) return email;
    const uid = String(exit.authorizerUid || '').trim();
    if (uid) return uid;
    return 'Pickup person';
  }
}
