import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  getDocs,
  query,
  where,
} from '@angular/fire/firestore';

export type PickupHistoryStatus =
  | 'on_time'
  | 'late'
  | 'missed'
  | 'arrived_only'
  | 'pending';

/**
 * One scheduled pickup occurrence joined with its matching Entered/Exited
 * scan events for the same fetcher on the same calendar day. Used by the
 * analytics page's "Pickup history" section.
 */
export type PickupHistoryRow = {
  id: string;
  childName: string;
  fetcherName: string;
  fetcherUid: string;
  scheduleYmd: string;
  scheduleDateLabel: string;
  scheduledTimeLabel: string;
  scheduledMs: number;
  arrivedAtMs: number;
  arrivedAtLabel: string;
  exitedAtMs: number;
  exitedAtLabel: string;
  status: PickupHistoryStatus;
  statusLabel: string;
};

/** Bounds for separate year + month panic pickers (local calendar). */
export type PanicSelectorBounds = {
  minYear: number;
  maxYear: number;
  /** 1–12: largest month index allowed when `year === maxYear`. */
  maxMonthInMaxYear: number;
};

export type SafetyAnalyticsResult = {
  pickupHistory: PickupHistoryRow[];
  /** Sorted ascending. Includes alerts from Jan 1 of the prior calendar year (local). */
  panicAlertMs: number[];
  panicSelectorBounds: PanicSelectorBounds;
  /** `YYYY-MM` for the current local month — default for the year/month pickers. */
  currentMonthValue: string;
};

interface ScheduleRow {
  id: string;
  dateRaw: unknown;
  time: string;
  days: string;
  childName: string;
  fetcherUid: string;
  fetcherName: string;
  status: string;
  createdAt: unknown;
  completedAt: unknown;
}

interface ScanEvent {
  action: 'Entered' | 'Exited';
  uid: string;
  whoLabel: string;
  ms: number;
  ymd: string;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsSafetyService {
  private readonly pickupHistoryLookbackDays = 30;
  /** Panic alerts loaded from local Jan 1 of (currentYear - 1) onward. */
  private readonly panicDataStartYearOffset = 1;
  private readonly graceMinutesAfterScheduled = 15;

  constructor(private firestore: Firestore) {}

  async loadSafetyAnalytics(
    familyName: string,
    opts?: {
      fetcherUid?: string | null;
      fetcherLabel?: string | null;
      memberNameByUid?: Map<string, string>;
    }
  ): Promise<SafetyAnalyticsResult> {
    const fam = String(familyName || '').trim();
    const today = new Date();
    const todayYmd = this.ymdLocal(today);
    const panicSelectorBounds = this.buildPanicSelectorBounds(today);
    const currentMonthValue = this.ymKeyLocal(today);

    if (!fam) {
      return {
        pickupHistory: [],
        panicAlertMs: [],
        panicSelectorBounds,
        currentMonthValue,
      };
    }

    const fetcherUid = String(opts?.fetcherUid ?? '').trim();
    const fetcherLabel = String(opts?.fetcherLabel ?? '').trim();
    const memberNameByUid = opts?.memberNameByUid ?? new Map<string, string>();

    const [pickupHistory, panicAlertMs] = await Promise.all([
      this.loadPickupHistory(
        fam,
        todayYmd,
        fetcherUid,
        fetcherLabel,
        memberNameByUid
      ),
      this.loadPanicAlertsSinceJanPriorYear(fam, today),
    ]);

    return {
      pickupHistory,
      panicAlertMs,
      panicSelectorBounds,
      currentMonthValue,
    };
  }

  /**
   * Build the bar buckets for one calendar month from a sorted-ascending
   * list of alert timestamps. Days in the future render as empty bars.
   */
  buildPanicMonthBuckets(
    panicAlertMs: number[],
    monthValue: string
  ): { dailyBuckets: { ymd: string; label: string; count: number }[]; total: number } {
    const parsed = this.parseYmKey(monthValue);
    if (!parsed) {
      return { dailyBuckets: [], total: 0 };
    }
    const { year, month } = parsed; // `month` is 0-indexed
    const startMs = new Date(year, month, 1, 0, 0, 0, 0).getTime();
    const endMs = new Date(year, month + 1, 1, 0, 0, 0, 0).getTime();

    const lastDay = new Date(year, month + 1, 0).getDate();
    const dailyBuckets: { ymd: string; label: string; count: number }[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const d = new Date(year, month, day);
      const ymd = this.ymdLocal(d);
      const label = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      dailyBuckets.push({ ymd, label, count: 0 });
    }
    const indexByYmd = new Map<string, number>();
    dailyBuckets.forEach((b, i) => indexByYmd.set(b.ymd, i));

    let total = 0;
    for (const ms of panicAlertMs) {
      if (ms < startMs || ms >= endMs) continue;
      const ymd = this.ymdLocal(new Date(ms));
      const idx = indexByYmd.get(ymd);
      if (idx == null) continue;
      dailyBuckets[idx].count += 1;
      total += 1;
    }
    return { dailyBuckets, total };
  }

  // --- Private helpers ---------------------------------------------------

  private async loadPickupHistory(
    familyName: string,
    todayYmd: string,
    fetcherUid: string,
    fetcherLabel: string,
    memberNameByUid: Map<string, string>
  ): Promise<PickupHistoryRow[]> {
    const windowStartYmd = this.addDaysYmd(
      todayYmd,
      -(this.pickupHistoryLookbackDays - 1)
    );

    const [scheduleRows, scanEvents] = await Promise.all([
      this.loadScheduleRows(familyName, windowStartYmd, todayYmd),
      this.loadScanEventIndex(familyName),
    ]);

    const merged = this.mergeDuplicateSchedules(scheduleRows);
    const todayMs = new Date().getTime();

    const out: PickupHistoryRow[] = [];
    for (const s of merged) {
      const ymd = this.scheduleDateYmdFromFirestore(s.dateRaw);
      if (!ymd || ymd < windowStartYmd || ymd > todayYmd) continue;

      // Scope filter: when a fetcher is selected we can match by UID; if the
      // schedule has no UID but the same display name we still include it
      // (mirrors how the legacy scan-event filter behaved).
      if (fetcherUid) {
        const uidMatches = s.fetcherUid && s.fetcherUid === fetcherUid;
        const labelMatches =
          !s.fetcherUid &&
          fetcherLabel &&
          this.namesMatch(fetcherLabel, s.fetcherName);
        if (!uidMatches && !labelMatches) continue;
      }

      const scheduledMs = this.scheduledInstantMs(ymd, s.time);
      const dateObj = this.parseYmdLocal(ymd);
      const dateLabel = dateObj
        ? dateObj.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })
        : ymd;
      const scheduledTimeLabel = scheduledMs
        ? this.formatTimeLabel(new Date(scheduledMs))
        : (s.time || '').trim() || '—';

      const fetcherDisplayName =
        s.fetcherName ||
        (s.fetcherUid ? memberNameByUid.get(s.fetcherUid) || '' : '') ||
        'Pickup person';

      const childDisplayName = s.childName || 'Child';

      const arrivals = scanEvents.byUidYmd.get(`${s.fetcherUid}|${ymd}|Entered`) ?? [];
      const exits = scanEvents.byUidYmd.get(`${s.fetcherUid}|${ymd}|Exited`) ?? [];

      const arrivedAtMs = arrivals.length > 0 ? arrivals[0].ms : 0;
      const exitCandidate = exits.find(
        (e) => arrivedAtMs === 0 || e.ms >= arrivedAtMs
      );
      const exitedAtMs = exitCandidate ? exitCandidate.ms : 0;

      const status = this.computeStatus(
        ymd,
        todayYmd,
        scheduledMs,
        todayMs,
        arrivedAtMs,
        exitedAtMs
      );

      out.push({
        id: s.id,
        childName: childDisplayName,
        fetcherName: fetcherDisplayName,
        fetcherUid: s.fetcherUid,
        scheduleYmd: ymd,
        scheduleDateLabel: dateLabel,
        scheduledTimeLabel,
        scheduledMs,
        arrivedAtMs,
        arrivedAtLabel: arrivedAtMs ? this.formatTimeLabel(new Date(arrivedAtMs)) : '',
        exitedAtMs,
        exitedAtLabel: exitedAtMs ? this.formatTimeLabel(new Date(exitedAtMs)) : '',
        status,
        statusLabel: this.statusLabel(status),
      });
    }

    out.sort((a, b) => {
      if (b.scheduledMs !== a.scheduledMs) return b.scheduledMs - a.scheduledMs;
      return a.id.localeCompare(b.id);
    });
    return out;
  }

  private computeStatus(
    ymd: string,
    todayYmd: string,
    scheduledMs: number,
    nowMs: number,
    arrivedAtMs: number,
    exitedAtMs: number
  ): PickupHistoryStatus {
    // Both arrival and exit recorded → punctuality is judged against the
    // exit time minus the scheduled time (with the 15 min grace window).
    if (arrivedAtMs && exitedAtMs && scheduledMs) {
      const deltaMin = (exitedAtMs - scheduledMs) / 60000;
      return deltaMin <= this.graceMinutesAfterScheduled ? 'on_time' : 'late';
    }
    // Arrived, but no exit recorded yet → "No exit yet" (waiting on a scan).
    if (arrivedAtMs && !exitedAtMs) {
      return 'arrived_only';
    }
    // Future day, or today's pickup that hasn't reached its scheduled time.
    if (ymd > todayYmd) return 'pending';
    if (ymd === todayYmd && scheduledMs && nowMs < scheduledMs) return 'pending';
    // Past schedule with NO arrival/exit on file → unambiguously missed.
    // (We intentionally do not honour any `Status === 'completed'` flag here:
    // without a real scan event we have no proof of an on-time pickup.)
    return 'missed';
  }

  private statusLabel(status: PickupHistoryStatus): string {
    switch (status) {
      case 'on_time':
        return 'On time';
      case 'late':
        return 'Late';
      case 'missed':
        return 'Missed';
      case 'arrived_only':
        return 'No exit yet';
      case 'pending':
      default:
        return 'Upcoming';
    }
  }

  private async loadScheduleRows(
    familyName: string,
    _windowStartYmd: string,
    _todayYmd: string
  ): Promise<ScheduleRow[]> {
    const snap = await getDocs(
      query(
        collection(this.firestore, 'Schedules'),
        where('Family Name', '==', familyName)
      )
    );
    const rows: ScheduleRow[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data() as Record<string, unknown>;
      rows.push({
        id: docSnap.id,
        dateRaw: d['Date'],
        time: String(d['Time'] ?? '').trim(),
        days: String(d['Days'] ?? '').trim(),
        childName: String(d['Childs Name'] ?? '').trim(),
        fetcherUid: String(d['Fetcher UID'] ?? '').trim(),
        fetcherName: String(d['Companions Name'] ?? '').trim(),
        status: String(d['Status'] ?? 'pending'),
        createdAt: d['Created At'],
        completedAt: d['Completed At'],
      });
    });
    return rows;
  }

  private async loadScanEventIndex(familyName: string): Promise<{
    byUidYmd: Map<string, ScanEvent[]>;
  }> {
    const snap = await getDocs(
      query(
        collection(this.firestore, 'ScanEvents'),
        where('familyName', '==', familyName)
      )
    );
    const byUidYmd = new Map<string, ScanEvent[]>();
    for (const docSnap of snap.docs) {
      const d = docSnap.data() as any;
      const rawAction = d?.action;
      const action: 'Entered' | 'Exited' | null =
        rawAction === 'Entered'
          ? 'Entered'
          : rawAction === 'Exited'
            ? 'Exited'
            : null;
      if (!action) continue;
      const uid = String(d?.authorizerUid || '').trim();
      const ms = this.timestampMs(d?.scannedAt);
      if (!uid || !ms) continue;
      const ymd = this.ymdLocal(new Date(ms));
      const key = `${uid}|${ymd}|${action}`;
      const arr = byUidYmd.get(key) ?? [];
      arr.push({
        action,
        uid,
        whoLabel: this.displayNameFromScan(d),
        ms,
        ymd,
      });
      byUidYmd.set(key, arr);
    }
    for (const arr of byUidYmd.values()) {
      arr.sort((a, b) => a.ms - b.ms);
    }
    return { byUidYmd };
  }

  private async loadPanicAlertsSinceJanPriorYear(
    familyName: string,
    today: Date
  ): Promise<number[]> {
    const sinceMs = new Date(
      today.getFullYear() - this.panicDataStartYearOffset,
      0,
      1,
      0,
      0,
      0,
      0
    ).getTime();
    const snap = await getDocs(
      query(
        collection(this.firestore, 'Panic Alert'),
        where('familyName', '==', familyName)
      )
    );
    const out: number[] = [];
    for (const docSnap of snap.docs) {
      const d = docSnap.data() as any;
      const t = this.timestampMs(d?.createdAt ?? d?.alertTime);
      if (!t || t < sinceMs) continue;
      out.push(t);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** Year range for panic UI: prior calendar year through current year; months clamp on current year. */
  private buildPanicSelectorBounds(today: Date): PanicSelectorBounds {
    const maxYear = today.getFullYear();
    const minYear = maxYear - this.panicDataStartYearOffset;
    return {
      minYear,
      maxYear,
      maxMonthInMaxYear: today.getMonth() + 1,
    };
  }

  private mergeDuplicateSchedules(rows: ScheduleRow[]): ScheduleRow[] {
    const groups = new Map<string, ScheduleRow[]>();
    for (const s of rows) {
      const ymd = this.scheduleDateYmdFromFirestore(s.dateRaw);
      const k = `${ymd}|${s.time}|${s.childName}|${s.fetcherUid}|${s.days}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    const out: ScheduleRow[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        out.push(group[0]);
        continue;
      }
      group.sort(
        (a, b) => this.timestampMs(b.createdAt) - this.timestampMs(a.createdAt)
      );
      out.push(group[0]);
    }
    return out;
  }

  private scheduledInstantMs(ymd: string, timeStr: string): number {
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;
    const [y, mo, d] = parts;
    const dayStart = new Date(y, mo - 1, d).getTime();
    const mins = this.parseScheduleTimeToMinutes(timeStr);
    if (!mins) return 0;
    return dayStart + mins * 60 * 1000;
  }

  private parseScheduleTimeToMinutes(timeString: string): number {
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
    if (
      typeof val === 'object' &&
      val !== null &&
      typeof (val as { toDate?: () => Date }).toDate === 'function'
    ) {
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

  private ymKeyLocal(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private parseYmKey(value: string): { year: number; month: number } | null {
    const parts = String(value || '').split('-');
    if (parts.length !== 2) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(y) || Number.isNaN(m) || m < 1 || m > 12) return null;
    return { year: y, month: m - 1 };
  }
}
