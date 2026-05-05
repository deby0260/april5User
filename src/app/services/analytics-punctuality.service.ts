import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  query,
  where,
  getDocs,
} from '@angular/fire/firestore';
import { ScheduleExitScanSyncService } from './schedule-exit-scan-sync.service';

/** Aggregated pickup punctuality for companion/fetcher performance (Schedules + ScanEvents). */
export interface AnalyticsPunctualityTotals {
  totalPickUps: number;
  onTimePickUps: number;
  missedPickUps: number;
  latePickUps: number;
  reliabilityScore: number;
}

export interface WeekBarDay {
  label: string;
  onTime: number;
  late: number;
  missed: number;
  /** 0–100 max bar height for stacking */
  maxStack: number;
}

export interface TrendWeek {
  label: string;
  score: number;
}

/** Distinct fetchers appearing on schedules (for analytics scope picker). */
export interface ScheduleFetcherOption {
  uid: string;
  label: string;
}

export interface LoadFamilyAnalyticsOptions {
  /** When set (including empty string for unknown UID), restrict stats to that fetcher’s assignments. */
  fetcherUid?: string | null;
  /** Optional map from Firebase uid → display name when schedule label is empty. */
  memberNameByUid?: Map<string, string>;
}

interface ScheduleRow {
  id: string;
  dateRaw: unknown;
  time: string;
  days: string;
  childName: string;
  fetcherUID: string;
  fetcherName: string;
  status: string;
  createdAt: unknown;
  completedAt: unknown;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsPunctualityService {
  /** Minutes after scheduled pickup time before counting as “late” */
  private readonly graceMinutesAfterScheduled = 15;
  /** How far back to include schedule rows */
  private readonly lookbackDays = 30;
  /** Bars: last N calendar days */
  private readonly weekBarDays = 7;
  /** Trend: last N weeks (rolling) */
  private readonly trendWeeks = 6;

  constructor(
    private firestore: Firestore,
    private scheduleExitScanSync: ScheduleExitScanSyncService
  ) {}

  async loadFamilyAnalytics(
    familyName: string,
    options?: LoadFamilyAnalyticsOptions
  ): Promise<{
    totals: AnalyticsPunctualityTotals;
    weekBars: WeekBarDay[];
    trend: TrendWeek[];
    fetcherOptions: ScheduleFetcherOption[];
  }> {
    if (!familyName?.trim()) {
      return {
        totals: this.emptyTotals(),
        weekBars: [],
        trend: [],
        fetcherOptions: [],
      };
    }

    await this.scheduleExitScanSync.syncExitScansToCompletedSchedules(familyName);

    const schedulesSnap = await getDocs(
      query(
        collection(this.firestore, 'Schedules'),
        where('Family Name', '==', familyName)
      )
    );

    const scanExitByDayUid = await this.loadExitScanTimesByDayAndUid(familyName);

    const rows: ScheduleRow[] = [];
    schedulesSnap.forEach((docSnap) => {
      const d = docSnap.data() as Record<string, unknown>;
      rows.push({
        id: docSnap.id,
        dateRaw: d['Date'],
        time: String(d['Time'] ?? '').trim(),
        days: String(d['Days'] ?? '').trim(),
        childName: String(d['Childs Name'] ?? '').trim(),
        fetcherUID: String(d['Fetcher UID'] ?? '').trim(),
        fetcherName: String(d['Companions Name'] ?? '').trim(),
        status: String(d['Status'] ?? 'pending'),
        createdAt: d['Created At'],
        completedAt: d['Completed At'],
      });
    });

    const todayYmd = this.ymdLocal(new Date());
    const windowStart = this.addDaysYmd(todayYmd, -this.lookbackDays);

    const merged = this.mergeDuplicateSchedules(rows);
    const inWindow = merged.filter((s) => {
      const ymd = this.scheduleDateYmdFromFirestore(s.dateRaw);
      return ymd >= windowStart && ymd <= todayYmd;
    });

    const fetcherOptions = this.buildFetcherOptions(inWindow, options?.memberNameByUid);

    const filterUid = options?.fetcherUid;
    const rowsForStats =
      filterUid === null || filterUid === undefined
        ? inWindow
        : inWindow.filter((s) => s.fetcherUID === filterUid);

    let onTime = 0;
    let late = 0;
    let missed = 0;

    const dayBuckets = new Map<string, { onTime: number; late: number; missed: number }>();
    const initDayBucket = (ymd: string) => {
      if (!dayBuckets.has(ymd)) {
        dayBuckets.set(ymd, { onTime: 0, late: 0, missed: 0 });
      }
      return dayBuckets.get(ymd)!;
    };

    const weekBuckets = new Map<string, { onTime: number; late: number; missed: number }>();
    const weekKeyFromYmd = (ymd: string): string => {
      const d = this.parseYmdLocal(ymd);
      if (!d) return '';
      const sun = new Date(d);
      sun.setDate(sun.getDate() - sun.getDay());
      return this.ymdLocal(sun);
    };

    for (const s of rowsForStats) {
      const ymd = this.scheduleDateYmdFromFirestore(s.dateRaw);
      if (!ymd) continue;

      const status = s.status || 'pending';
      if (status === 'pending') {
        if (ymd < todayYmd) {
          missed++;
          initDayBucket(ymd).missed++;
          const wk = weekKeyFromYmd(ymd);
          if (wk) {
            if (!weekBuckets.has(wk)) weekBuckets.set(wk, { onTime: 0, late: 0, missed: 0 });
            weekBuckets.get(wk)!.missed++;
          }
        }
        continue;
      }

      if (status !== 'completed') continue;

      const scheduledMs = this.scheduledInstantMs(ymd, s.time);
      if (!scheduledMs) continue;

      const actualMs = this.resolveActualCompletionMs(s, ymd, scanExitByDayUid);
      if (!actualMs) continue;

      const deltaMin = (actualMs - scheduledMs) / 60000;
      const bucket = initDayBucket(ymd);
      const wk = weekKeyFromYmd(ymd);
      if (wk && !weekBuckets.has(wk)) weekBuckets.set(wk, { onTime: 0, late: 0, missed: 0 });
      const wb = wk ? weekBuckets.get(wk)! : null;

      if (deltaMin <= this.graceMinutesAfterScheduled) {
        onTime++;
        bucket.onTime++;
        if (wb) wb.onTime++;
      } else {
        late++;
        bucket.late++;
        if (wb) wb.late++;
      }
    }

    const total = onTime + late + missed;
    const reliabilityScore =
      total > 0 ? Math.round((100 * onTime) / total) : 0;

    const weekBars = this.buildWeekBars(dayBuckets, todayYmd);
    const trend = this.buildTrend(weekBuckets, todayYmd);

    return {
      totals: {
        totalPickUps: total,
        onTimePickUps: onTime,
        missedPickUps: missed,
        latePickUps: late,
        reliabilityScore,
      },
      weekBars,
      trend,
      fetcherOptions,
    };
  }

  private buildFetcherOptions(
    inWindow: ScheduleRow[],
    memberNameByUid?: Map<string, string>
  ): ScheduleFetcherOption[] {
    const byUid = new Map<string, string>();

    for (const s of inWindow) {
      const uid = s.fetcherUID;
      const fromSchedule = s.fetcherName.trim();
      const fromMember = uid ? (memberNameByUid?.get(uid) ?? '').trim() : '';
      const candidate =
        fromSchedule ||
        fromMember ||
        (uid ? 'Unknown assignee' : 'Unknown assignee');

      const prev = byUid.get(uid);
      if (!prev) {
        byUid.set(uid, candidate);
      } else if (fromSchedule.length > 0 && fromSchedule.length >= prev.length) {
        byUid.set(uid, candidate);
      }
    }

    const out: ScheduleFetcherOption[] = [];
    for (const [uid, label] of byUid) {
      out.push({ uid, label });
    }
    out.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    );
    return out;
  }

  private emptyTotals(): AnalyticsPunctualityTotals {
    return {
      totalPickUps: 0,
      onTimePickUps: 0,
      missedPickUps: 0,
      latePickUps: 0,
      reliabilityScore: 0,
    };
  }

  /**
   * Exit scan times per calendar day + fetcher UID (same validity as ScheduleExitScanSyncService).
   */
  private async loadExitScanTimesByDayAndUid(
    familyName: string
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const snap = await getDocs(
      query(
        collection(this.firestore, 'ScanEvents'),
        where('familyName', '==', familyName)
      )
    );

    type Ev = { action: 'Entered' | 'Exited'; uid: string; scannedAt: unknown; ms: number };
    const events: Ev[] = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const raw = data['action'];
      const action =
        raw === 'Exited' ? 'Exited' : raw === 'Entered' ? 'Entered' : null;
      if (!action) continue;
      const uid = String(data['authorizerUid'] ?? '').trim();
      const scannedAt = data['scannedAt'];
      const ms = this.timestampMs(scannedAt);
      if (!uid || !ms) continue;
      events.push({ action, uid, scannedAt, ms });
    }
    events.sort((a, b) => a.ms - b.ms);

    const exits = events.filter((e) => {
      if (e.action !== 'Exited') return false;
      const ymd = this.toLocalYmdFromScan(e.scannedAt);
      if (!ymd) return false;
      const hasPriorEnter = events.some(
        (x) =>
          x.action === 'Entered' &&
          x.uid === e.uid &&
          this.toLocalYmdFromScan(x.scannedAt) === ymd &&
          x.ms < e.ms
      );
      return hasPriorEnter;
    });

    for (const e of exits) {
      const ymd = this.toLocalYmdFromScan(e.scannedAt);
      const key = `${ymd}|${e.uid}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(e.ms);
    }
    for (const arr of out.values()) {
      arr.sort((a, b) => a - b);
    }
    return out;
  }

  private resolveActualCompletionMs(
    s: ScheduleRow,
    ymd: string,
    scanExitByDayUid: Map<string, number[]>
  ): number {
    const exits = scanExitByDayUid.get(`${ymd}|${s.fetcherUID}`) ?? [];
    const completedMs = this.timestampMs(s.completedAt);
    if (exits.length > 0 && completedMs > 0) {
      let best = exits[0];
      let bestDiff = Math.abs(best - completedMs);
      for (const x of exits) {
        const d = Math.abs(x - completedMs);
        if (d < bestDiff) {
          best = x;
          bestDiff = d;
        }
      }
      if (bestDiff <= 120000) {
        return best;
      }
    }
    if (completedMs > 0) {
      return completedMs;
    }
    return exits.length > 0 ? exits[0] : 0;
  }

  private mergeDuplicateSchedules(rows: ScheduleRow[]): ScheduleRow[] {
    const groups = new Map<string, ScheduleRow[]>();
    for (const s of rows) {
      const ymd = this.scheduleDateYmdFromFirestore(s.dateRaw);
      const k = `${ymd}|${String(s.time || '').trim()}|${String(s.childName || '').trim()}|${s.fetcherUID}|${String(s.days || '').trim()}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    const out: ScheduleRow[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        out.push(group[0]);
        continue;
      }
      group.sort((a, b) => this.createdAtMs(b.createdAt) - this.createdAtMs(a.createdAt));
      out.push(group[0]);
    }
    return out;
  }

  private buildWeekBars(
    dayBuckets: Map<string, { onTime: number; late: number; missed: number }>,
    todayYmd: string
  ): WeekBarDay[] {
    const bars: WeekBarDay[] = [];
    for (let i = this.weekBarDays - 1; i >= 0; i--) {
      const ymd = this.addDaysYmd(todayYmd, -i);
      const d = this.parseYmdLocal(ymd);
      const label = d
        ? d.toLocaleDateString(undefined, { weekday: 'short' })
        : '';
      const b = dayBuckets.get(ymd) ?? { onTime: 0, late: 0, missed: 0 };
      const maxStack = Math.max(b.onTime + b.late + b.missed, 1);
      bars.push({
        label,
        onTime: b.onTime,
        late: b.late,
        missed: b.missed,
        maxStack,
      });
    }
    return bars;
  }

  private buildTrend(
    weekBuckets: Map<string, { onTime: number; late: number; missed: number }>,
    todayYmd: string
  ): TrendWeek[] {
    const trend: TrendWeek[] = [];
    const today = this.parseYmdLocal(todayYmd);
    if (!today) return trend;

    for (let w = this.trendWeeks - 1; w >= 0; w--) {
      const end = new Date(today);
      end.setDate(end.getDate() - w * 7);
      const sun = new Date(end);
      sun.setDate(sun.getDate() - sun.getDay());
      const wk = this.ymdLocal(sun);

      const agg = weekBuckets.get(wk) ?? { onTime: 0, late: 0, missed: 0 };
      const den = agg.onTime + agg.late + agg.missed;
      const score = den > 0 ? Math.round((100 * agg.onTime) / den) : 0;
      const label = `${sun.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })}`;

      trend.push({ label, score });
    }
    return trend;
  }

  private scheduledInstantMs(ymd: string, timeStr: string): number {
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;
    const [y, mo, d] = parts;
    const dayStart = new Date(y, mo - 1, d).getTime();
    const mins = this.parseScheduleTimeToMinutesSafe(timeStr);
    return dayStart + mins * 60 * 1000;
  }

  private parseScheduleTimeToMinutesSafe(timeString: string): number {
    if (!timeString) return 0;
    const t = timeString.trim();
    if (!t) return 0;
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const s = ampm[3] != null ? parseInt(ampm[3], 10) : 0;
      const ap = ampm[4].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return h * 60 + m + s / 60;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      const h = parseInt(h24[1], 10);
      const m = parseInt(h24[2], 10);
      const s = h24[3] != null ? parseInt(h24[3], 10) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(m)) return h * 60 + m + s / 60;
    }
    return 0;
  }

  private scheduleDateYmdFromFirestore(val: unknown): string {
    if (val == null) return '';
    if (typeof val === 'string') return this.toLocalYmdFromDateString(val);
    if (typeof val === 'object' && val !== null && typeof (val as { toDate?: () => Date }).toDate === 'function') {
      const d = (val as { toDate: () => Date }).toDate();
      return this.ymdLocal(d);
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
    return this.ymdLocal(d);
  }

  private toLocalYmdFromScan(timestamp: unknown): string {
    if (!timestamp) return '';
    try {
      const d =
        typeof (timestamp as { toDate?: () => Date }).toDate === 'function'
          ? (timestamp as { toDate: () => Date }).toDate()
          : new Date(timestamp as string | number);
      if (Number.isNaN(d.getTime())) return '';
      return this.ymdLocal(d);
    } catch {
      return '';
    }
  }

  private ymdLocal(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private parseYmdLocal(ymd: string): Date | null {
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
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

  private timestampMs(v: unknown): number {
    if (v == null) return 0;
    if (typeof (v as { toMillis?: () => number }).toMillis === 'function') {
      return (v as { toMillis: () => number }).toMillis();
    }
    if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
      const d = (v as { toDate: () => Date }).toDate();
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof v === 'object' && v !== null && typeof (v as { seconds?: number }).seconds === 'number') {
      return (v as { seconds: number }).seconds * 1000;
    }
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    const d = new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  private createdAtMs(v: unknown): number {
    return this.timestampMs(v);
  }
}
