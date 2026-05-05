import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  getDocs,
  query,
  where,
} from '@angular/fire/firestore';

export type SafetyScanAction = 'Entered' | 'Exited';

export type SafetyScanLogRow = {
  id: string;
  action: SafetyScanAction;
  who: string;
  whoUid: string;
  whenMs: number;
  /** Time-only label like `2:05 PM` */
  whenLabel: string;
  /** Full label like `Tuesday, May 1, 2:05 PM` */
  whenFullLabel: string;
  title: string;
  subtitle: string;
};

export type PanicDailyBucket = {
  /** Local day key `YYYY-MM-DD` */
  ymd: string;
  /** Short label for display */
  label: string;
  count: number;
};

export type SafetyAnalyticsResult = {
  scanLogs: SafetyScanLogRow[];
  panicTotal30d: number;
  panicDaily30d: PanicDailyBucket[];
};

@Injectable({ providedIn: 'root' })
export class AnalyticsSafetyService {
  private readonly lookbackDays = 30;

  constructor(private firestore: Firestore) {}

  async loadSafetyAnalytics(
    familyName: string,
    opts?: { fetcherUid?: string | null; fetcherLabel?: string | null }
  ): Promise<SafetyAnalyticsResult> {
    const fam = String(familyName || '').trim();
    if (!fam) {
      return { scanLogs: [], panicTotal30d: 0, panicDaily30d: [] };
    }

    const today = new Date();
    const todayYmd = this.ymdLocal(today);
    const windowStartYmd = this.addDaysYmd(todayYmd, -this.lookbackDays + 1);
    const windowStartMs = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (this.lookbackDays - 1),
      0,
      0,
      0,
      0
    ).getTime();

    const fetcherUid = String(opts?.fetcherUid ?? '').trim();
    const fetcherLabel = String(opts?.fetcherLabel ?? '').trim();

    const [scanLogs, panicRows] = await Promise.all([
      this.loadScanLogs(
        fam,
        windowStartMs,
        windowStartYmd,
        todayYmd,
        fetcherUid,
        fetcherLabel
      ),
      this.loadPanicAlerts(fam, windowStartMs),
    ]);

    const panicDaily30d = this.buildDailyBuckets30d(todayYmd);
    const dayIndex = new Map<string, number>();
    panicDaily30d.forEach((b, i) => dayIndex.set(b.ymd, i));

    let panicTotal30d = 0;
    for (const ms of panicRows) {
      const ymd = this.ymdLocal(new Date(ms));
      const idx = dayIndex.get(ymd);
      if (idx == null) continue;
      panicDaily30d[idx].count += 1;
      panicTotal30d += 1;
    }

    return { scanLogs, panicTotal30d, panicDaily30d };
  }

  private async loadScanLogs(
    familyName: string,
    windowStartMs: number,
    windowStartYmd: string,
    todayYmd: string,
    fetcherUid: string,
    fetcherLabel: string
  ): Promise<SafetyScanLogRow[]> {
    const eventsCol = collection(this.firestore, 'ScanEvents');
    const snap = await getDocs(query(eventsCol, where('familyName', '==', familyName)));

    const out: SafetyScanLogRow[] = [];
    for (const docSnap of snap.docs) {
      const d = docSnap.data() as any;
      const rawAction = d?.action;
      const action: SafetyScanAction | null =
        rawAction === 'Entered' ? 'Entered' : rawAction === 'Exited' ? 'Exited' : null;
      if (!action) continue;

      const whoUid = String(d?.authorizerUid || '').trim();

      const scannedAt = d?.scannedAt;
      const whenMs = this.timestampMs(scannedAt);
      if (!whenMs || whenMs < windowStartMs) continue;

      // Guard: when timestampMs is usable but day parsing is odd, clamp to the 30d window by ymd as well.
      const ymd = this.ymdLocal(new Date(whenMs));
      if (ymd < windowStartYmd || ymd > todayYmd) continue;

      const who = this.displayNameFromScan(d);

      // Scope filter: prefer UID match; fall back to matching by the selected label if UID is missing.
      if (fetcherUid) {
        if (whoUid) {
          if (fetcherUid !== whoUid) continue;
        } else if (fetcherLabel) {
          if (!this.namesMatch(fetcherLabel, who)) continue;
        } else {
          // No UID and no label to match against → cannot safely attribute this row.
          continue;
        }
      }
      const whenLabel = this.formatTimeLabel(new Date(whenMs));
      const whenFullLabel = this.formatFullDateTimeLabel(new Date(whenMs));

      const title =
        action === 'Entered' ? `${who} has arrived` : `${who} has left the school`;
      const subtitle =
        action === 'Entered'
          ? `Arrived at ${whenLabel} — ${whenFullLabel}`
          : `Exited at ${whenLabel} — ${whenFullLabel}`;

      out.push({
        id: docSnap.id,
        action,
        who,
        whoUid,
        whenMs,
        whenLabel,
        whenFullLabel,
        title,
        subtitle,
      });
    }

    out.sort((a, b) => b.whenMs - a.whenMs);
    return out;
  }

  private async loadPanicAlerts(familyName: string, windowStartMs: number): Promise<number[]> {
    const alertsCol = collection(this.firestore, 'Panic Alert');
    const snap = await getDocs(query(alertsCol, where('familyName', '==', familyName)));

    const ms: number[] = [];
    for (const docSnap of snap.docs) {
      const d = docSnap.data() as any;
      const createdAt = d?.createdAt ?? d?.alertTime;
      const t = this.timestampMs(createdAt);
      if (!t || t < windowStartMs) continue;
      ms.push(t);
    }
    return ms;
  }

  private buildDailyBuckets30d(todayYmd: string): PanicDailyBucket[] {
    const out: PanicDailyBucket[] = [];
    for (let i = this.lookbackDays - 1; i >= 0; i--) {
      const ymd = this.addDaysYmd(todayYmd, -i);
      const d = this.parseYmdLocal(ymd);
      const label = d
        ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : ymd;
      out.push({ ymd, label, count: 0 });
    }
    return out;
  }

  private displayNameFromScan(data: {
    authorizerName?: string | null;
    authorizerEmail?: string | null;
    authorizerUid?: string | null;
  }): string {
    const name = String(data?.authorizerName || '').trim();
    if (name) return name;
    const email = String(data?.authorizerEmail || '').trim();
    if (email) return email;
    const uid = String(data?.authorizerUid || '').trim();
    if (uid) return uid;

    // Common alternate field names seen in some ScanEvents writers.
    const altName =
      String((data as any)?.name || '').trim() ||
      String((data as any)?.displayName || '').trim() ||
      String((data as any)?.fetcherName || '').trim() ||
      String((data as any)?.authorizer || '').trim();
    if (altName) return altName;

    return 'Pickup person';
  }

  private namesMatch(a: string, b: string): boolean {
    const na = this.normName(a);
    const nb = this.normName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Allow simple containment to handle “First Last” vs “First” (best-effort).
    return na.includes(nb) || nb.includes(na);
  }

  private normName(s: string): string {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N} ]/gu, '');
  }

  private formatTimeLabel(d: Date): string {
    try {
      return d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  }

  private formatFullDateTimeLabel(d: Date): string {
    try {
      return d.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  }

  private timestampMs(v: any): number {
    if (v == null) return 0;
    if (typeof v?.toMillis === 'function') {
      return v.toMillis();
    }
    if (typeof v?.toDate === 'function') {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof v === 'object' && typeof v?.seconds === 'number') {
      return v.seconds * 1000;
    }
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    const d = new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  private ymdLocal(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private parseYmdLocal(ymd: string): Date | null {
    const parts = String(ymd || '')
      .split('-')
      .map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    const [y, mo, d] = parts;
    return new Date(y, mo - 1, d);
  }

  private addDaysYmd(ymd: string, delta: number): string {
    const d = this.parseYmdLocal(ymd);
    if (!d) return ymd;
    d.setDate(d.getDate() + delta);
    return this.ymdLocal(d);
  }
}

