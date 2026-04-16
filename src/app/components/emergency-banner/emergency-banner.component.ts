import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, getDocs, limit, orderBy, query, where } from '@angular/fire/firestore';
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

  async refresh(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      // Keep showing cached emergency until we can confirm resolution.
      return;
    }

    const family = await this.familyService.getUserFamily();
    if (!family?.name) {
      // Keep showing cached emergency until we can confirm resolution.
      return;
    }

    const alertsRef = collection(this.firestore, 'Panic Alert');
    const q = query(
      alertsRef,
      where('familyName', '==', family.name),
      where('resolved', '==', false),
      orderBy('createdAt', 'desc'),
      limit(1)
    );

    const snap = await getDocs(q);
    if (snap.empty) {
      // Only clear once we've successfully checked the family and confirmed no unresolved alerts.
      this.activeEmergency = null;
      this.panicService.setActiveEmergencyBanner(null);
      this.clearCachedEmergency(family.name);
      return;
    }

    const data = snap.docs[0].data() as any;
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

