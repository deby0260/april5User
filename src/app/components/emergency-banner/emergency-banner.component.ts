import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, getDocs, limit, query, where } from '@angular/fire/firestore';
import { AuthService } from '../../services/auth';
import { FamilyService } from '../../services/family.service';
import { ActiveEmergencyBannerState, PanicService } from '../../services/panic.service';

type ActiveEmergency = ActiveEmergencyBannerState;

@Component({
  selector: 'app-emergency-banner',
  templateUrl: './emergency-banner.component.html',
  styleUrls: ['./emergency-banner.component.scss'],
  standalone: false
})
export class EmergencyBannerComponent implements OnInit, OnDestroy {
  activeEmergency: ActiveEmergency | null = null;
  private pollHandle: any;

  constructor(
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private router: Router,
    private panicService: PanicService
  ) { }

  async ngOnInit() {
    // Paint from cache immediately; then refresh on a short interval.
    this.loadCachedEmergency();

    this.panicService.activeEmergency$.subscribe((state) => {
      if (state) {
        this.activeEmergency = state;
        this.setCachedEmergency(state);
      } else {
        this.activeEmergency = null;
        this.clearAllEmergencyCaches();
      }
    });

    await this.refresh();
    this.pollHandle = setInterval(() => void this.refresh(), 12000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }
  }

  private cacheKey(familyName: string): string {
    return `activeEmergency:${familyName}`;
  }

  private loadCachedEmergency(): void {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      // We don't know the family yet here; try to load any recent cached emergency.
      // This is a best-effort fallback to prevent banner flicker.
      const possibleKeys = Object.keys(localStorage).filter(k => k.startsWith('activeEmergency:'));
      if (possibleKeys.length === 0) return;

      // Pick the most recently written entry (stored inside value).
      let best: ActiveEmergency | null = null;
      for (const k of possibleKeys) {
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as ActiveEmergency & { cachedAtMs?: number };
        if (!parsed?.triggeredByName || !parsed?.createdAtMs || !parsed?.familyName) continue;
        if (!best || (parsed.cachedAtMs ?? 0) > ((best as any).cachedAtMs ?? 0)) {
          best = parsed as any;
        }
      }

      if (best) {
        this.activeEmergency = best;
      }
    } catch {
      // ignore cache parse errors
    }
  }

  private setCachedEmergency(e: ActiveEmergency): void {
    try {
      localStorage.setItem(
        this.cacheKey(e.familyName),
        JSON.stringify({ ...e, cachedAtMs: Date.now() })
      );
    } catch {
      // ignore storage errors
    }
  }

  private clearCachedEmergency(familyName: string): void {
    try {
      localStorage.removeItem(this.cacheKey(familyName));
    } catch {
      // ignore storage errors
    }
  }

  /** Remove all persisted emergency banner snapshots (e.g. after logout or resolve). */
  private clearAllEmergencyCaches(): void {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('activeEmergency:')) {
          localStorage.removeItem(k);
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  private dismissBannerAndCaches(): void {
    this.activeEmergency = null;
    this.panicService.setActiveEmergencyBanner(null);
    this.clearAllEmergencyCaches();
  }

  async refresh(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.dismissBannerAndCaches();
      return;
    }

    const family = await this.familyService.getUserFamily();
    if (!family?.name) {
      // Keep showing cached/last-known banner if we can't resolve family yet.
      // We'll try again on the next refresh tick.
      return;
    }

    try {
      const alertsRef = collection(this.firestore, 'Panic Alert');
      const q = query(
        alertsRef,
        where('familyName', '==', family.name),
        limit(25)
      );

      const snap = await getDocs(q);
      if (snap.empty) {
        this.activeEmergency = null;
        this.panicService.setActiveEmergencyBanner(null);
        this.clearAllEmergencyCaches();
        return;
      }

      // IMPORTANT UX RULE:
      // Show/hide the banner based ONLY on the *latest* panic alert.
      // (Older unresolved docs should not keep the banner alive once the most recent alert is resolved.)
      const rows = snap.docs.map((docSnap) => {
        const d = docSnap.data() as any;
        const unresolved = !this.isResolvedPanicDoc(d);
        let t = this.timestampMs(d?.createdAt ?? d?.alertTime);
        // Newly created docs often have `serverTimestamp()` that hasn't materialized yet.
        // If it's unresolved but timestamp is missing, treat it as newest to avoid banner flicker.
        if (unresolved && t <= 0) {
          t = Date.now();
        }
        return { docSnap, data: d, t, unresolved };
      });

      rows.sort((a, b) => b.t - a.t);

      const latest = rows[0] ?? null;
      const latestDoc = latest?.docSnap ?? null;
      const latestData = latest?.data;
      const latestResolved = latestData ? this.isResolvedPanicDoc(latestData) : true;

      if (!latestDoc || latestResolved) {
        this.activeEmergency = null;
        this.panicService.setActiveEmergencyBanner(null);
        this.clearAllEmergencyCaches();
        return;
      }

      const data = latestData;
      const triggeredByName =
        data?.alertTriggeredBy ||
        data?.['Parents Name'] ||
        data?.senderName ||
        'A family member';

      const createdAt = data?.createdAt ?? data?.alertTime;
      const createdAtMs =
        createdAt?.toDate?.()?.getTime?.() ??
        (createdAt ? new Date(createdAt).getTime() : Date.now());

      this.activeEmergency = { triggeredByName, createdAtMs, familyName: family.name };
      this.panicService.setActiveEmergencyBanner(this.activeEmergency);
      this.setCachedEmergency(this.activeEmergency);
    } catch (e) {
      console.warn('EmergencyBanner: refresh query failed', e);
      // Keep showing last-known emergency state until we can confirm resolution.
      // (Do not clear caches on transient query failures.)
    }
  }

  private isResolvedPanicDoc(data: any): boolean {
    const resolvedVal =
      data?.resolved ??
      data?.Resolved ??
      data?.isResolved ??
      data?.is_resolved ??
      data?.resolvedAt ??
      data?.resolved_at;

    const statusRaw = data?.status ?? data?.Status ?? data?.STATE ?? data?.state;
    const statusVal = String(statusRaw || '').trim().toLowerCase();

    const resolvedStr = String(resolvedVal ?? '').trim().toLowerCase();
    const resolvedTruthy =
      resolvedVal === true ||
      resolvedVal === 1 ||
      resolvedVal === '1' ||
      resolvedVal === 'true' ||
      resolvedVal === 'TRUE' ||
      resolvedStr === 'resolved' ||
      resolvedStr === 'yes';

    return (
      resolvedTruthy ||
      statusVal === 'resolved' ||
      statusVal === 'closed' ||
      statusVal === 'done'
    );
  }

  private timestampMs(v: any): number {
    if (v == null) return 0;
    if (typeof v?.toMillis === 'function') return v.toMillis();
    if (typeof v?.toDate === 'function') {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof v === 'object' && typeof v?.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    const d = new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  get timeText(): string {
    if (!this.activeEmergency) return '';
    const d = new Date(this.activeEmergency.createdAtMs);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  openNotifications(): void {
    void this.router.navigate(['/notifications']);
  }
}

