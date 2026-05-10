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
  PanicSelectorBounds,
  PickupHistoryRow,
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

  // Start in the loading state so the very first render shows the spinner
  // instead of momentarily flashing the zero-initialized stat cards before
  // `ionViewWillEnter` kicks off the real data fetch.
  isLoading = true;
  loadError: string | null = null;

  canViewSafetySections = false;
  accessDeniedMessage: string | null = null;

  /**
   * Tracks an in-flight role/access lookup so `refreshAnalytics` can safely
   * fire in parallel with `refreshAccess` and just-in-time await the access
   * result before deciding whether to load the safety analytics section.
   */
  private accessReadyPromise: Promise<void> | null = null;

  pickupHistoryLoading = false;
  pickupHistoryError: string | null = null;
  pickupHistory: PickupHistoryRow[] = [];
  pickupHistoryPage = 1;
  readonly pickupHistoryPageSize = 5;

  /**
   * Raw panic alert timestamps (ms) from local Jan 1 of the prior calendar year.
   * Sorted ascending. Month buckets are derived client-side.
   */
  private panicAlertMs: number[] = [];
  panicSelectorBounds: PanicSelectorBounds | null = null;
  /** Local calendar year shown in the panic year picker. */
  selectedPanicYear: number | null = null;
  /** 1–12, local calendar month in the panic month picker. */
  selectedPanicMonth: number | null = null;
  panicTotalMonth = 0;
  panicDailyMonth: { ymd: string; label: string; count: number }[] = [];
  panicMaxDailyMonth = 0;

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
    // Flip to loading synchronously BEFORE any await so re-entries to the page
    // (which retain the previous render state) immediately hide stale data and
    // show the spinner while data fetches in parallel.
    this.isLoading = true;
    // Kick off role-access in parallel with the heavy analytics fetch.
    // `refreshAnalytics` will await this promise just before its safety
    // section, so the gate check stays race-free while we save one round trip.
    this.accessReadyPromise = this.refreshAccess();
    try {
      await Promise.all([this.accessReadyPromise, this.refreshAnalytics()]);
    } finally {
      this.accessReadyPromise = null;
    }
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
    this.pickupHistoryError = null;
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
        this.resetSafetyState();
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

      // Ensure the role/access lookup (which may have been started in parallel
      // by ionViewWillEnter) has settled before we gate on canViewSafetySections.
      // Without this await, a slow access lookup could race past this check on
      // the very first load and cause the safety section to be silently skipped.
      if (this.accessReadyPromise) {
        try {
          await this.accessReadyPromise;
        } catch {
          /* refreshAccess swallows its own errors and falls back safely */
        }
      }

      if (this.canViewSafetySections) {
        await this.refreshSafetyAnalytics(family.name, memberNameByUid);
      } else {
        this.resetSafetyState();
      }
    } catch (e) {
      this.loadError = 'Could not load analytics. Try again.';
    } finally {
      this.isLoading = false;
    }
  }

  private async refreshSafetyAnalytics(
    familyName: string,
    memberNameByUid: Map<string, string>
  ): Promise<void> {
    this.pickupHistoryLoading = true;
    this.pickupHistoryError = null;
    try {
      const fetcherUid = this.selectedFetcherUid === null ? null : this.selectedFetcherUid;
      const fetcherLabel =
        this.selectedFetcherUid === null
          ? null
          : this.fetcherOptions.find((o) => o.uid === this.selectedFetcherUid)?.label ?? null;
      const res = await this.analyticsSafety.loadSafetyAnalytics(familyName, {
        fetcherUid,
        fetcherLabel,
        memberNameByUid,
      });
      this.pickupHistory = res.pickupHistory;
      this.pickupHistoryPage = 1;
      this.panicAlertMs = res.panicAlertMs;
      this.panicSelectorBounds = res.panicSelectorBounds;
      const b = res.panicSelectorBounds;
      const fallback = this.parseYmKey(res.currentMonthValue);
      const fy = fallback?.year ?? b.maxYear;
      const fm = fallback?.month1 ?? b.maxMonthInMaxYear;
      if (!this.isValidPanicSelection(this.selectedPanicYear, this.selectedPanicMonth, b)) {
        this.selectedPanicYear = fy;
        this.selectedPanicMonth = fm;
      }
      this.recomputePanicMonthBuckets();
    } catch (e) {
      this.resetSafetyState();
      this.pickupHistoryError = 'Could not load safety analytics. Try again.';
    } finally {
      this.pickupHistoryLoading = false;
    }
  }

  private resetSafetyState(): void {
    this.pickupHistory = [];
    this.pickupHistoryPage = 1;
    this.panicAlertMs = [];
    this.panicSelectorBounds = null;
    this.selectedPanicYear = null;
    this.selectedPanicMonth = null;
    this.panicTotalMonth = 0;
    this.panicDailyMonth = [];
    this.panicMaxDailyMonth = 0;
  }

  /**
   * ISO-8601 (without timezone) for the currently picked month, used by
   * `ion-datetime` `[value]`. Ionic only cares about year + month here, but
   * a full `YYYY-MM-DDTHH:mm:ss` payload keeps the parser happy.
   */
  get panicSelectedIso(): string {
    if (this.selectedPanicYear == null || this.selectedPanicMonth == null) return '';
    const mm = String(this.selectedPanicMonth).padStart(2, '0');
    return `${this.selectedPanicYear}-${mm}-01T00:00:00`;
  }

  /** Lower bound for `ion-datetime [min]`: Jan 1 of the earliest selectable year. */
  get panicMinIso(): string {
    const b = this.panicSelectorBounds;
    if (!b) return '';
    return `${b.minYear}-01-01T00:00:00`;
  }

  /** Upper bound for `ion-datetime [max]`: end of the current local month. */
  get panicMaxIso(): string {
    const b = this.panicSelectorBounds;
    if (!b) return '';
    const mm = String(b.maxMonthInMaxYear).padStart(2, '0');
    const lastDay = new Date(b.maxYear, b.maxMonthInMaxYear, 0).getDate();
    const dd = String(lastDay).padStart(2, '0');
    return `${b.maxYear}-${mm}-${dd}T23:59:59`;
  }

  onPanicDateChange(event: Event): void {
    const detail = (event as CustomEvent).detail as
      | { value?: string | string[] | null }
      | undefined;
    const raw = detail?.value;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return;
    const m = String(value).match(/^(\d{4})-(\d{2})/);
    if (!m) return;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (
      Number.isNaN(year) ||
      Number.isNaN(month) ||
      !this.isValidPanicSelection(year, month, this.panicSelectorBounds)
    ) {
      return;
    }
    if (year === this.selectedPanicYear && month === this.selectedPanicMonth) return;
    this.selectedPanicYear = year;
    this.selectedPanicMonth = month;
    this.recomputePanicMonthBuckets();
  }

  private isValidPanicSelection(
    year: number | null,
    month: number | null,
    b: PanicSelectorBounds | null
  ): boolean {
    if (!b || year == null || month == null) return false;
    if (year < b.minYear || year > b.maxYear) return false;
    const maxM = year === b.maxYear ? b.maxMonthInMaxYear : 12;
    return month >= 1 && month <= maxM;
  }

  private parseYmKey(ym: string): { year: number; month1: number } | null {
    const parts = String(ym || '').split('-');
    if (parts.length !== 2) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(y) || Number.isNaN(m) || m < 1 || m > 12) return null;
    return { year: y, month1: m };
  }

  private selectedPanicYmKey(): string | null {
    if (this.selectedPanicYear == null || this.selectedPanicMonth == null) return null;
    const mm = String(this.selectedPanicMonth).padStart(2, '0');
    return `${this.selectedPanicYear}-${mm}`;
  }

  private recomputePanicMonthBuckets(): void {
    const ym = this.selectedPanicYmKey();
    if (!ym) {
      this.panicTotalMonth = 0;
      this.panicDailyMonth = [];
      this.panicMaxDailyMonth = 0;
      return;
    }
    const { dailyBuckets, total } = this.analyticsSafety.buildPanicMonthBuckets(
      this.panicAlertMs,
      ym
    );
    this.panicDailyMonth = dailyBuckets;
    this.panicTotalMonth = total;
    this.panicMaxDailyMonth = Math.max(1, ...dailyBuckets.map((d) => d.count));
  }

  get panicMonthHeading(): string {
    if (this.selectedPanicYear == null || this.selectedPanicMonth == null) {
      return 'Panic usage';
    }
    const d = new Date(this.selectedPanicYear, this.selectedPanicMonth - 1, 15);
    const label = d.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    return `Panic usage (${label})`;
  }

  panicBarHeightPct(count: number): number {
    if (!this.panicMaxDailyMonth) return 0;
    return Math.round((count / this.panicMaxDailyMonth) * 1000) / 10;
  }

  pickupStatusClass(status: PickupHistoryRow['status']): string {
    return `status-${status}`;
  }

  visiblePickupHistory(): PickupHistoryRow[] {
    const start = (this.pickupHistoryPage - 1) * this.pickupHistoryPageSize;
    const end = start + this.pickupHistoryPageSize;
    return this.pickupHistory.slice(start, end);
  }

  pickupHistoryTotalPages(): number {
    const n = this.pickupHistory.length;
    return n > 0 ? Math.ceil(n / this.pickupHistoryPageSize) : 1;
  }

  pickupHistoryPageLabel(): string {
    if (!this.pickupHistory.length) return '';
    return `Page ${this.pickupHistoryPage} of ${this.pickupHistoryTotalPages()}`;
  }

  canPickupHistoryPrev(): boolean {
    return this.pickupHistoryPage > 1;
  }

  canPickupHistoryNext(): boolean {
    return this.pickupHistoryPage < this.pickupHistoryTotalPages();
  }

  pickupHistoryPrevPage(): void {
    if (!this.canPickupHistoryPrev()) return;
    this.pickupHistoryPage -= 1;
  }

  pickupHistoryNextPage(): void {
    if (!this.canPickupHistoryNext()) return;
    this.pickupHistoryPage += 1;
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
