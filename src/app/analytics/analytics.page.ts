import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import {
  AnalyticsPunctualityService,
  AnalyticsPunctualityTotals,
  ScheduleFetcherOption,
  TrendWeek,
  WeekBarDay,
} from '../services/analytics-punctuality.service';
import {
  AnalyticsSafetyService,
  PanicDailyBucket,
  SafetyScanLogRow,
} from '../services/analytics-safety.service';
import { FamilyMember, FamilyService } from '../services/family.service';
import { RoleAccessService } from '../services/role-access.service';

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

  canViewSafetySections = false;
  accessDeniedMessage: string | null = null;

  scanLogsLoading = false;
  scanLogsError: string | null = null;
  scanLogs: SafetyScanLogRow[] = [];
  scanLogsPage = 1;
  readonly scanLogsPageSize = 5;

  panicTotal30d = 0;
  panicDaily30d: PanicDailyBucket[] = [];
  panicMaxDaily30d = 0;

  /** SVG polyline `points` for weekly reliability trend */
  trendPolylinePoints = '';

  constructor(
    private location: Location,
    private analyticsPunctuality: AnalyticsPunctualityService,
    private analyticsSafety: AnalyticsSafetyService,
    private familyService: FamilyService,
    private roleAccess: RoleAccessService
  ) {}

  ngOnInit() {
    this.calculateProgress();
  }

  async ionViewWillEnter() {
    await this.refreshAccess();
    await this.refreshAnalytics();
  }

  private async refreshAccess(): Promise<void> {
    try {
      const role = await this.roleAccess.getUserRole();
      this.canViewSafetySections = Boolean(role?.canAccessAnalytics);
      this.accessDeniedMessage = this.canViewSafetySections
        ? null
        : this.roleAccess.getAccessDeniedMessage('analytics', role?.role);
    } catch {
      this.canViewSafetySections = false;
      this.accessDeniedMessage =
        'Only family owners and parents can access analytics.';
    }
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
    this.scanLogsError = null;
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
        this.scanLogs = [];
        this.panicTotal30d = 0;
        this.panicDaily30d = [];
        this.panicMaxDaily30d = 0;
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

      if (this.canViewSafetySections) {
        await this.refreshSafetyAnalytics(family.name);
      } else {
        this.scanLogs = [];
        this.panicTotal30d = 0;
        this.panicDaily30d = [];
        this.panicMaxDaily30d = 0;
      }
    } catch (e) {
      this.loadError = 'Could not load analytics. Try again.';
    } finally {
      this.isLoading = false;
    }
  }

  private async refreshSafetyAnalytics(familyName: string): Promise<void> {
    this.scanLogsLoading = true;
    this.scanLogsError = null;
    try {
      const fetcherUid = this.selectedFetcherUid === null ? null : this.selectedFetcherUid;
      const fetcherLabel =
        this.selectedFetcherUid === null
          ? null
          : this.fetcherOptions.find((o) => o.uid === this.selectedFetcherUid)?.label ?? null;
      const res = await this.analyticsSafety.loadSafetyAnalytics(familyName, {
        fetcherUid,
        fetcherLabel,
      });
      this.scanLogs = res.scanLogs;
      this.scanLogsPage = 1;
      this.panicTotal30d = res.panicTotal30d;
      this.panicDaily30d = res.panicDaily30d;
      this.panicMaxDaily30d = Math.max(1, ...res.panicDaily30d.map((d) => d.count));
    } catch (e) {
      this.scanLogs = [];
      this.scanLogsPage = 1;
      this.panicTotal30d = 0;
      this.panicDaily30d = [];
      this.panicMaxDaily30d = 0;
      this.scanLogsError = 'Could not load safety analytics. Try again.';
    } finally {
      this.scanLogsLoading = false;
    }
  }

  panicBarHeightPct(count: number): number {
    if (!this.panicMaxDaily30d) return 0;
    return Math.round((count / this.panicMaxDaily30d) * 1000) / 10;
  }

  visibleScanLogs(): SafetyScanLogRow[] {
    const start = (this.scanLogsPage - 1) * this.scanLogsPageSize;
    const end = start + this.scanLogsPageSize;
    return this.scanLogs.slice(start, end);
  }

  scanLogsTotalPages(): number {
    const n = this.scanLogs.length;
    return n > 0 ? Math.ceil(n / this.scanLogsPageSize) : 1;
  }

  scanLogsPageLabel(): string {
    if (!this.scanLogs.length) return '';
    return `Page ${this.scanLogsPage} of ${this.scanLogsTotalPages()}`;
  }

  canScanLogsPrev(): boolean {
    return this.scanLogsPage > 1;
  }

  canScanLogsNext(): boolean {
    return this.scanLogsPage < this.scanLogsTotalPages();
  }

  scanLogsPrevPage(): void {
    if (!this.canScanLogsPrev()) return;
    this.scanLogsPage -= 1;
  }

  scanLogsNextPage(): void {
    if (!this.canScanLogsNext()) return;
    this.scanLogsPage += 1;
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

    // Include all people who may act as fetcher, even if they have no schedules in the lookback,
    // so the parent can still select them and see zero/empty analytics rather than disappearing.
    for (const m of members) {
      if (!['owner', 'parent', 'companion'].includes(m.role)) continue;
      const label = (m.name || '').trim() || 'Family member';
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
