import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import {
  AnalyticsPunctualityService,
  AnalyticsPunctualityTotals,
  ScheduleFetcherOption,
  TrendWeek,
  WeekBarDay,
} from '../services/analytics-punctuality.service';
import { FamilyMember, FamilyService } from '../services/family.service';

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  standalone: false,
})
export class AnalyticsPage implements OnInit {
  /** Sentinel for ion-select “everyone” (Ionic select values work better as strings). */
  readonly allFetchersValue = '__ALL__';

  /** Null = combined family-wide stats; otherwise `Fetcher UID` from schedules (may be empty string). */
  selectedFetcherUid: string | null = null;

  fetcherOptions: ScheduleFetcherOption[] = [];

  analytics: AnalyticsPunctualityTotals = {
    totalPickUps: 0,
    onTimePickUps: 0,
    missedPickUps: 0,
    latePickUps: 0,
    reliabilityScore: 0,
  };

  weekBars: WeekBarDay[] = [];
  trend: TrendWeek[] = [];

  circumference = 2 * Math.PI * 26;
  strokeDashoffset = 0;

  isLoading = false;
  loadError: string | null = null;

  /** SVG polyline `points` for weekly reliability trend */
  trendPolylinePoints = '';

  constructor(
    private location: Location,
    private analyticsPunctuality: AnalyticsPunctualityService,
    private familyService: FamilyService
  ) {}

  ngOnInit() {
    this.calculateProgress();
  }

  async ionViewWillEnter() {
    await this.refreshAnalytics();
  }

  get scopeSelectModel(): string {
    return this.selectedFetcherUid === null ? this.allFetchersValue : this.selectedFetcherUid;
  }

  get scopeBannerText(): string {
    if (this.selectedFetcherUid === null) {
      return 'All pickup assignments — every companion / fetcher assigned on schedules (combined).';
    }
    const name =
      this.fetcherOptions.find((o) => o.uid === this.selectedFetcherUid)?.label ??
      'Selected fetcher';
    return `Showing data for ${name} only.`;
  }

  get reliabilityHeading(): string {
    if (this.selectedFetcherUid === null) {
      return 'Family punctuality';
    }
    const name =
      this.fetcherOptions.find((o) => o.uid === this.selectedFetcherUid)?.label ?? 'Fetcher';
    return `${name}'s punctuality`;
  }

  async onFetcherScopeChange(event: CustomEvent<{ value: string }>) {
    const v = event.detail?.value;
    this.selectedFetcherUid = v === this.allFetchersValue ? null : v;
    await this.refreshAnalytics();
  }

  async refreshAnalytics() {
    this.isLoading = true;
    this.loadError = null;
    try {
      const family = await this.familyService.getUserFamily();
      if (!family?.name) {
        this.analytics = {
          totalPickUps: 0,
          onTimePickUps: 0,
          missedPickUps: 0,
          latePickUps: 0,
          reliabilityScore: 0,
        };
        this.weekBars = [];
        this.trend = [];
        this.trendPolylinePoints = '';
        this.fetcherOptions = [];
        this.selectedFetcherUid = null;
        this.calculateProgress();
        return;
      }

      const members = await this.familyService.getFamilyMembers(family.name);
      const memberNameByUid = new Map(members.map((m) => [m.uid, m.name]));

      let fetcherUidArg =
        this.selectedFetcherUid === null ? undefined : this.selectedFetcherUid;

      let result = await this.analyticsPunctuality.loadFamilyAnalytics(family.name, {
        fetcherUid: fetcherUidArg,
        memberNameByUid,
      });

      let mergedOptions = this.buildAnalyticsFetcherOptions(
        result.fetcherOptions,
        members
      );

      if (
        fetcherUidArg !== undefined &&
        !mergedOptions.some((o) => o.uid === fetcherUidArg)
      ) {
        this.selectedFetcherUid = null;
        result = await this.analyticsPunctuality.loadFamilyAnalytics(family.name, {
          memberNameByUid,
        });
        mergedOptions = this.buildAnalyticsFetcherOptions(
          result.fetcherOptions,
          members
        );
      }

      this.fetcherOptions = mergedOptions;

      if (
        this.selectedFetcherUid !== null &&
        !this.fetcherOptions.some((o) => o.uid === this.selectedFetcherUid)
      ) {
        this.selectedFetcherUid = null;
        result = await this.analyticsPunctuality.loadFamilyAnalytics(family.name, {
          memberNameByUid,
        });
        this.fetcherOptions = this.buildAnalyticsFetcherOptions(
          result.fetcherOptions,
          members
        );
      }

      this.analytics = result.totals;
      this.weekBars = result.weekBars;
      this.trend = result.trend;

      this.buildTrendSvg();
      this.calculateProgress();
    } catch (e) {
      console.error('Analytics load failed', e);
      this.loadError = 'Could not load analytics. Try again.';
    } finally {
      this.isLoading = false;
    }
  }

  private buildTrendSvg(): void {
    if (!this.trend.length) {
      this.trendPolylinePoints = '';
      return;
    }
    const W = 300;
    const H = 120;
    const padX = 24;
    const padY = 22;
    const n = this.trend.length;
    const points = this.trend.map((t, i) => {
      const x = n <= 1 ? W / 2 : padX + (i / (n - 1)) * (W - 2 * padX);
      const score = Math.min(100, Math.max(0, t.score));
      const y = padY + (1 - score / 100) * (H - 2 * padY);
      return `${x},${y}`;
    });
    this.trendPolylinePoints = points.join(' ');
  }

  barHeightPct(count: number, maxStack: number): number {
    if (!maxStack) return 0;
    return Math.round((count / maxStack) * 1000) / 10;
  }

  calculateProgress() {
    const progress = this.analytics.reliabilityScore / 100;
    this.strokeDashoffset = this.circumference - progress * this.circumference;
  }

  goBack() {
    this.location.back();
  }

  /**
   * Picker: every family member with role `companion`, plus any assignee on `Schedules`
   * in the lookback (e.g. a parent who acted as fetcher). Companions with no recent
   * schedule rows still appear so the parent can view their stats (likely zeros).
   */
  private buildAnalyticsFetcherOptions(
    scheduleOptions: ScheduleFetcherOption[],
    members: FamilyMember[]
  ): ScheduleFetcherOption[] {
    const byUid = new Map<string, ScheduleFetcherOption>();

    for (const o of scheduleOptions) {
      byUid.set(o.uid, { uid: o.uid, label: o.label });
    }

    for (const m of members) {
      if (m.role !== 'companion') continue;
      const label = (m.name || '').trim() || 'Companion';
      if (!byUid.has(m.uid)) {
        byUid.set(m.uid, { uid: m.uid, label });
      }
    }

    const out = Array.from(byUid.values());
    out.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    );
    return out;
  }
}
