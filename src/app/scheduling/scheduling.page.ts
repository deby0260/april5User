import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import {
  Firestore,
  collection,
  addDoc,
  doc,
  serverTimestamp,
  query,
  where,
  getDocs,
  writeBatch,
} from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService, FamilyMember } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { NotificationService } from '../services/notification.service';
import { LoadingController, ToastController } from '@ionic/angular';
import { RoleAccessService } from '../services/role-access.service';
import type { DatetimeHighlightCallback } from '@ionic/core';

/** How far the scheduled pickup repeats from the start date. */
export type ScheduleRepeatMode = 'single' | 'whole_month';

interface ScheduleData {
  fetcherUID: string;
  fetcherName: string;
  companionName: string;
  selectedChildren: any[];
  selectedDays: string[];
  /** YYYY-MM-DD on the calendar; must match one of selectedDays; other selected weekdays use the same calendar week */
  selectedDate: string;
  selectedTime: string;
  familyName: string;
  parentName: string;
  /** Repeat behaviour applied to the (start) `selectedDate` + `selectedDays` set. */
  repeatMode: ScheduleRepeatMode;
  /**
   * Whole-month mode only: dates the user has tapped to skip (e.g. "Mondays
   * but not the last one"). Cleared when fetcher / weekdays / month / mode
   * changes so we never carry stale skips across selections.
   */
  excludedDates: string[];
}

/** Passed from view-schedule via router state when editing an existing pickup */
export interface ScheduleEditState {
  docIds: string[];
  fetcherUID: string;
  fetcherName: string;
  days: string;
  selectedDate: string;
  time: string;
  childName: string;
  childGrade: string;
}

@Component({
  selector: 'app-scheduling',
  templateUrl: './scheduling.page.html',
  styleUrls: ['./scheduling.page.scss'],
  standalone: false
})
export class SchedulingPage implements OnInit {
  scheduleData: ScheduleData = {
    fetcherUID: '',
    fetcherName: '',
    companionName: '',
    selectedChildren: [],
    selectedDays: [],
    selectedDate: '',
    selectedTime: '00:00',
    familyName: '',
    parentName: '',
    repeatMode: 'single',
    excludedDates: [],
  };

  familyMembers: FamilyMember[] = [];
  children: any[] = [];
  currentUserRole: string = '';
  canManageSchedule: boolean = false;
  /** False until loadUserRole finishes — avoids showing "no access" while role is still loading */
  scheduleAccessLoading = true;
  minDate: string = '';
  maxDate: string = '';
  /** Bumps when weekday selection changes so ion-datetime remounts cleanly */
  calendarRemountKey = 0;
  private saveInProgress = false;
  /** Firestore doc ids to replace when saving (edit mode); null when creating */
  private editDocIds: string[] | null = null;
  isEditMode = false;
  private pendingEditState: ScheduleEditState | null = null;

  private static readonly LABEL_TO_MONDAY_OFFSET: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };

  private static readonly DAY_SORT_ORDER: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };

  constructor(
    private location: Location,
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private roleAccessService: RoleAccessService,
    private notificationService: NotificationService
  ) {
    const nav = this.router.getCurrentNavigation();
    const fromNav = nav?.extras?.state?.['editSchedule'] as ScheduleEditState | undefined;
    if (fromNav?.docIds?.length) {
      this.pendingEditState = fromNav;
    }
  }

  async ngOnInit() {
    const today = new Date();
    this.minDate = today.toISOString();

    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    this.maxDate = maxDate.toISOString();

    this.hydrateRoleFromCache();
    const hadCachedRole = !!this.roleAccessService.getCachedUserRole();
    this.scheduleAccessLoading = !hadCachedRole;
    try {
      await this.loadFamilyAndRole();
    } finally {
      this.scheduleAccessLoading = false;
    }

    let toApply = this.pendingEditState;
    this.pendingEditState = null;
    if (!toApply && typeof history !== 'undefined') {
      const st = history.state as { editSchedule?: ScheduleEditState } | null;
      if (st?.editSchedule?.docIds?.length) {
        toApply = st.editSchedule;
      }
    }
    if (toApply && this.canManageSchedule) {
      this.applyEditState(toApply);
    }
  }

  private applyEditState(state: ScheduleEditState): void {
    this.editDocIds = [...state.docIds];
    this.isEditMode = true;
    this.scheduleData.fetcherUID = state.fetcherUID;
    this.scheduleData.fetcherName = state.fetcherName;
    this.scheduleData.companionName = state.fetcherName;
    const dayParts = state.days.split(',').map((d) => d.trim()).filter(Boolean);
    this.scheduleData.selectedDays = dayParts.length > 0 ? dayParts : [];
    this.scheduleData.selectedDate = state.selectedDate;
    this.scheduleData.selectedTime = state.time || '00:00';
    // Editing operates on a single existing week — start in `single` mode so
    // the user sees identical-to-create-time behaviour. They can still expand
    // to whole_month if they want to broaden the series to the full month.
    this.scheduleData.repeatMode = 'single';
    this.scheduleData.excludedDates = [];
    const match = this.children.find((c) => c.name === state.childName);
    this.scheduleData.selectedChildren = match
      ? [match]
      : [{ name: state.childName, grade: state.childGrade || '' }];
    this.calendarRemountKey += 1;
  }

  private hydrateRoleFromCache(): void {
    this.roleAccessService.applyUserRole((role) => {
      this.currentUserRole = role.role;
      this.canManageSchedule = role.canAccessScheduling;
    });
  }

  /**
   * Single coordinated init pass: resolve the user's family once, then fan
   * out members/children/role in parallel.
   */
  private async loadFamilyAndRole(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const family = await this.familyService.getUserFamily();
      if (!family) return;

      this.scheduleData.familyName = family.name;
      this.scheduleData.parentName = currentUser.fullName || currentUser.email || 'Parent';

      const [members, children, userRole] = await Promise.all([
        this.familyService.getFamilyMembers(family.name),
        this.familyService.getFamilyChildren(family.name),
        this.roleAccessService.getUserRole(),
      ]);

      this.familyMembers = members;
      this.children = children;

      if (userRole) {
        this.currentUserRole = userRole.role;
        this.canManageSchedule = userRole.canAccessScheduling;
      } else {
        const userMember = members.find((member) => member.uid === currentUser.uid);
        if (userMember) {
          this.currentUserRole = userMember.role;
          this.canManageSchedule =
            userMember.role === 'owner' || userMember.role === 'parent';
        }
      }
    } catch (error) {
    }
  }

  async loadFamilyData() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const family = await this.familyService.getUserFamily();
      if (!family) return;

      this.scheduleData.familyName = family.name;
      this.scheduleData.parentName = currentUser.fullName || currentUser.email || 'Parent';

      this.familyMembers = await this.familyService.getFamilyMembers(family.name);

      this.children = await this.familyService.getFamilyChildren(family.name);
    } catch (error) {
    }
  }

  async loadUserRole() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const family = await this.familyService.getUserFamily();
      if (!family) return;

      const userRole = await this.roleAccessService.getUserRole();

      if (userRole) {
        this.currentUserRole = userRole.role;
        this.canManageSchedule = userRole.canAccessScheduling;
      } else {
        const members = await this.familyService.getFamilyMembers(family.name);
        const userMember = members.find((member) => member.uid === currentUser.uid);

        if (userMember) {
          this.currentUserRole = userMember.role;
          this.canManageSchedule = userMember.role === 'owner' || userMember.role === 'parent';
        }
      }
    } catch (error) {
    }
  }

  getAvailableFetchers(): FamilyMember[] {
    if (!this.canManageSchedule) {
      return [];
    }
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return [];
    }

    const eligible = this.familyMembers.filter(
      (member) =>
        member.role === 'owner' || member.role === 'parent' || member.role === 'companion'
    );

    const byUid = new Map<string, FamilyMember>();
    for (const m of eligible) {
      byUid.set(m.uid, m);
    }

    if (!byUid.has(currentUser.uid)) {
      const role =
        this.currentUserRole === 'owner' || this.currentUserRole === 'parent'
          ? (this.currentUserRole as FamilyMember['role'])
          : ('parent' as FamilyMember['role']);
      byUid.set(currentUser.uid, {
        id: currentUser.uid,
        uid: currentUser.uid,
        name: currentUser.fullName || currentUser.email || 'Me',
        email: currentUser.email || '',
        contactNumber: currentUser.contactNumber || '',
        role,
        joinedDate: null,
      });
    }

    return Array.from(byUid.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }

  onFetcherSelected(event: any) {
    const uid = event.detail.value as string | null | undefined;
    if (!uid) {
      this.scheduleData.fetcherUID = '';
      this.scheduleData.fetcherName = '';
      this.scheduleData.companionName = '';
      this.scheduleData.selectedDays = [];
      this.scheduleData.selectedDate = '';
      this.scheduleData.repeatMode = 'single';
      this.scheduleData.excludedDates = [];
      this.calendarRemountKey += 1;
      return;
    }
    const member = this.getAvailableFetchers().find((m) => m.uid === uid);
    if (!member) {
      return;
    }
    const uidChanged = this.scheduleData.fetcherUID !== member.uid;
    this.scheduleData.fetcherUID = member.uid;
    this.scheduleData.fetcherName = member.name;
    this.scheduleData.companionName = member.name;
    if (uidChanged) {
      this.scheduleData.selectedDays = [];
      this.scheduleData.selectedDate = '';
      this.scheduleData.repeatMode = 'single';
      this.scheduleData.excludedDates = [];
      this.calendarRemountKey += 1;
    }
  }

  toggleChildSelection(child: any) {
    const index = this.scheduleData.selectedChildren.findIndex((c) => c.name === child.name);
    if (index > -1) {
      this.scheduleData.selectedChildren.splice(index, 1);
    } else {
      this.scheduleData.selectedChildren.push(child);
    }
  }

  isChildSelected(child: any): boolean {
    return this.scheduleData.selectedChildren.some((c) => c.name === child.name);
  }

  selectAllChildren() {
    this.scheduleData.selectedChildren = [...this.children];
  }

  clearAllChildren() {
    this.scheduleData.selectedChildren = [];
  }

  toggleDay(day: string) {
    if (this.scheduleData.selectedDays.includes(day)) {
      this.scheduleData.selectedDays = this.scheduleData.selectedDays.filter((d) => d !== day);
    } else {
      this.scheduleData.selectedDays = Array.from(new Set([...this.scheduleData.selectedDays, day]));
    }
    // The set of "matching" dates just changed → drop any per-date skips so the
    // user never carries a stale exclusion (e.g. last Monday) into a different
    // weekday selection.
    this.scheduleData.excludedDates = [];
    this.syncSelectedDateAfterDaysChange();
    this.calendarRemountKey += 1;
  }

  onDateChange(event: any) {
    const raw = event?.detail?.value;
    if (!raw) return;
    const ymd = String(raw).split('T')[0];
    if (!ymd) return;

    // In whole-month mode the inline calendar doubles as a per-date skip
    // toggle: tapping a tinted matching weekday in the *currently anchored
    // month* flips its excluded state; tapping a date in another month is
    // treated as picking that month (skips reset).
    if (this.isRepeatMode('whole_month')) {
      const anchor = this.scheduleData.selectedDate;
      if (anchor && this.isYmdSameCalendarMonth(ymd, anchor)) {
        this.toggleWholeMonthExclusion(ymd);
        return;
      }
      this.scheduleData.excludedDates = [];
      this.scheduleData.selectedDate = ymd;
      this.calendarRemountKey += 1;
      return;
    }

    this.scheduleData.selectedDate = ymd;
  }

  /**
   * Whole-month mode: flip a date between "scheduled" and "skipped". The
   * caller already verified this is a matching weekday in the anchored month.
   * `calendarRemountKey` is bumped so `<ion-datetime>`'s highlight callback
   * re-runs and the visual state stays in sync.
   */
  private toggleWholeMonthExclusion(ymd: string): void {
    const current = this.scheduleData.excludedDates ?? [];
    if (current.includes(ymd)) {
      this.scheduleData.excludedDates = current.filter((d) => d !== ymd);
    } else {
      this.scheduleData.excludedDates = [...current, ymd];
    }
    this.calendarRemountKey += 1;
  }

  /** Used by the "Reset skipped days" button in the template. */
  resetWholeMonthExclusions(): void {
    if (!this.isRepeatMode('whole_month')) return;
    if (this.scheduleData.excludedDates.length === 0) return;
    this.scheduleData.excludedDates = [];
    this.calendarRemountKey += 1;
  }

  /** Template helper: how many dates are currently being skipped. */
  getWholeMonthExcludedCount(): number {
    if (!this.isRepeatMode('whole_month')) return 0;
    return this.scheduleData.excludedDates.length;
  }

  /**
   * Compact label for the "skipped" chip, e.g. `Skipping: May 25` or
   * `Skipping: May 4, 11, 25`. Hidden when the skip list is empty.
   */
  getWholeMonthExcludedSummary(): string {
    if (!this.isRepeatMode('whole_month')) return '';
    const skipped = (this.scheduleData.excludedDates ?? [])
      .filter((d) => this.isYmdSameCalendarMonth(d, this.scheduleData.selectedDate))
      .sort();
    if (skipped.length === 0) return '';
    const [yFirst, moFirst] = skipped[0].split('-').map(Number);
    if (!yFirst || !moFirst) return '';
    const monthLabel = new Date(yFirst, moFirst - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
    });
    const days = skipped
      .map((d) => parseInt(d.split('-')[2], 10))
      .filter((n) => !Number.isNaN(n))
      .join(', ');
    return `Skipping: ${monthLabel} ${days}`;
  }

  /** ion-datetime: noon avoids DST / timezone day-shift */
  get selectedDateIonValue(): string {
    const d = this.scheduleData.selectedDate;
    if (!d || this.scheduleData.selectedDays.length === 0) {
      return '';
    }
    return d.includes('T') ? d : `${d}T12:00:00`;
  }

  trackCalendarShell = (_index: number, shell: { key: string }) => shell.key;

  get calendarShells(): { key: string }[] {
    const daysKey = [...this.scheduleData.selectedDays].sort().join(',') || 'none';
    return [{ key: `${daysKey}-${this.calendarRemountKey}` }];
  }

  private weekdayFromIonCalendarDay(iso: string): number {
    const datePart = String(iso).split('T')[0];
    const parts = datePart.split('-').map((p) => parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return new Date(iso).getDay();
    }
    const [y, m, d] = parts;
    return new Date(y, m - 1, d).getDay();
  }

  private labelToJsDay(label: string): number {
    const dayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    return dayMap[label] ?? -1;
  }

  isDateEnabled = (dateIsoString: string) => {
    if (this.scheduleData.selectedDays.length === 0) {
      return true;
    }
    const dayOfWeek = this.weekdayFromIonCalendarDay(dateIsoString);
    return this.scheduleData.selectedDays.some((day) => this.labelToJsDay(day) === dayOfWeek);
  };

  /**
   * Tint selected weekdays only inside the same Mon-start week as the chosen date.
   * The tapped date uses Ionic's default "selected" styling (no duplicate tint).
   */
  highlightMatchingWeekdays: DatetimeHighlightCallback = (dateIsoString: string) => {
    if (this.scheduleData.selectedDays.length === 0 || !this.scheduleData.selectedDate) {
      return undefined;
    }
    if (!this.isDateEnabled(dateIsoString)) {
      return undefined;
    }
    const datePart = String(dateIsoString).split('T')[0];
    if (datePart === this.scheduleData.selectedDate) {
      return undefined;
    }
    if (!this.isYmdSameMondayWeek(datePart, this.scheduleData.selectedDate)) {
      return undefined;
    }
    return {
      backgroundColor: 'rgba(18, 156, 174, 0.38)',
      textColor: '#0f2d2f',
    };
  };

  /**
   * Whole-month variant: tint EVERY matching weekday in the same calendar
   * month as `selectedDate`, clipped to `[minDate, maxDate]` so days that
   * won't actually be saved (e.g. past days in the current month) stay
   * un-tinted. Excluded ("skipped") matching dates render in a muted red so
   * the user can see exactly which dates they've opted out of. The focused
   * day uses Ionic's default selected styling unless it's been excluded.
   */
  highlightWholeMonthMatchingDays: DatetimeHighlightCallback = (dateIsoString: string) => {
    if (this.scheduleData.selectedDays.length === 0 || !this.scheduleData.selectedDate) {
      return undefined;
    }
    if (!this.isDateEnabled(dateIsoString)) {
      return undefined;
    }
    const datePart = String(dateIsoString).split('T')[0];
    const minPart = this.minDate.split('T')[0];
    const maxPart = this.maxDate.split('T')[0];
    if (datePart < minPart || datePart > maxPart) {
      return undefined;
    }
    if (!this.isYmdSameCalendarMonth(datePart, this.scheduleData.selectedDate)) {
      return undefined;
    }
    const excluded = (this.scheduleData.excludedDates ?? []).includes(datePart);
    if (excluded) {
      // Muted red — clearly "off" but still tappable so the user can re-include it.
      return {
        backgroundColor: 'rgba(220, 53, 69, 0.28)',
        textColor: '#9a2632',
      };
    }
    if (datePart === this.scheduleData.selectedDate) {
      // Let Ionic draw its native "selected" ring on the anchor.
      return undefined;
    }
    return {
      backgroundColor: 'rgba(18, 156, 174, 0.38)',
      textColor: '#0f2d2f',
    };
  };

  /** Same YYYY-MM segment in two YMD strings. */
  private isYmdSameCalendarMonth(aYmd: string, bYmd: string): boolean {
    return aYmd.slice(0, 7) === bYmd.slice(0, 7);
  }

  /** Same calendar week (Monday 00:00 as boundary), local time */
  private isYmdSameMondayWeek(aYmd: string, bYmd: string): boolean {
    return this.mondayOfWeekContaining(aYmd).getTime() === this.mondayOfWeekContaining(bYmd).getTime();
  }

  getFormattedDate(): string {
    if (!this.scheduleData.selectedDate) return 'Select date';

    const [y, m, d] = this.scheduleData.selectedDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  private firstAvailableDateMatchingSelectedDays(): string {
    if (this.scheduleData.selectedDays.length === 0) {
      return '';
    }
    const want = new Set(
      this.scheduleData.selectedDays.map((d) => this.labelToJsDay(d)).filter((n) => n >= 0)
    );

    const minPart = this.minDate.split('T')[0];
    const maxPart = this.maxDate.split('T')[0];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 400; i++) {
      const cand = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      if (!want.has(cand.getDay())) {
        continue;
      }
      const y = cand.getFullYear();
      const mo = String(cand.getMonth() + 1).padStart(2, '0');
      const dayNum = String(cand.getDate()).padStart(2, '0');
      const ymd = `${y}-${mo}-${dayNum}`;
      if (ymd >= minPart && ymd <= maxPart) {
        return ymd;
      }
    }
    return '';
  }

  private syncSelectedDateAfterDaysChange() {
    if (this.scheduleData.selectedDays.length === 0) {
      this.scheduleData.selectedDate = '';
      return;
    }
    if (!this.scheduleData.selectedDate) {
      this.scheduleData.selectedDate = this.firstAvailableDateMatchingSelectedDays();
      return;
    }
    const dow = this.weekdayFromIonCalendarDay(this.scheduleData.selectedDate);
    const ok = this.scheduleData.selectedDays.some((d) => this.labelToJsDay(d) === dow);
    if (!ok) {
      this.scheduleData.selectedDate = this.firstAvailableDateMatchingSelectedDays();
    }
  }

  private mondayOfWeekContaining(ymd: string): Date {
    const parts = ymd.split('-').map((p) => parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return new Date(ymd);
    }
    const [y, m, d] = parts;
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    const offsetToMonday = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + offsetToMonday);
    mon.setHours(0, 0, 0, 0);
    return mon;
  }

  private ymdFromDate(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  /**
   * Materialises one entry per (selected weekday × week) within the active
   * repeat window. Modes:
   *   - `single`: keep legacy behaviour — every selected weekday in the same
   *     Mon-start week as `selectedDate`, even days earlier in that week
   *     than the picked date.
   *   - `whole_month`: weeks within the picked date's calendar month, clipped
   *     to `[selectedDate, last day of that month]` so the user gets exactly
   *     what the calendar shows.
   */
  private buildToSaveEntries(): { dayLabel: string; date: string }[] {
    const startYmd = this.scheduleData.selectedDate;
    if (!startYmd) return [];

    if (this.scheduleData.repeatMode === 'single') {
      return this.buildEntriesForWeekContaining(startYmd);
    }

    const endYmd = this.computeEffectiveEndYmd();
    if (!endYmd || endYmd < startYmd) {
      // Fall back to the start week if the user hasn't set a valid end date yet.
      return this.buildEntriesForWeekContaining(startYmd);
    }

    const sortedDays = this.sortedSelectedDays();
    const out: { dayLabel: string; date: string }[] = [];
    const endDate = this.parseYmdLocal(endYmd);
    if (!endDate) return out;

    let cursor = this.mondayOfWeekContaining(startYmd);
    // Hard safety cap so an unbounded loop can never run; max ~14 months.
    let safety = 0;
    while (cursor.getTime() <= endDate.getTime() && safety < 64) {
      for (const label of sortedDays) {
        const off = SchedulingPage.LABEL_TO_MONDAY_OFFSET[label];
        if (off === undefined) continue;
        const d = new Date(cursor);
        d.setDate(cursor.getDate() + off);
        const ymd = this.ymdFromDate(d);
        if (ymd >= startYmd && ymd <= endYmd) {
          out.push({ dayLabel: label, date: ymd });
        }
      }
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 7);
      safety += 1;
    }

    // User-tapped skips (e.g. "all Mondays except the last one") drop out
    // here so the preview, save payload, and reminder syncs all agree.
    const excluded = this.scheduleData.excludedDates;
    if (excluded && excluded.length > 0) {
      const skip = new Set(excluded);
      return out.filter((e) => !skip.has(e.date));
    }
    return out;
  }

  /** Legacy single-week entry generator (preserves prior behaviour). */
  private buildEntriesForWeekContaining(ymd: string): { dayLabel: string; date: string }[] {
    const monday = this.mondayOfWeekContaining(ymd);
    const out: { dayLabel: string; date: string }[] = [];
    for (const label of this.sortedSelectedDays()) {
      const off = SchedulingPage.LABEL_TO_MONDAY_OFFSET[label];
      if (off === undefined) continue;
      const d = new Date(monday);
      d.setDate(monday.getDate() + off);
      out.push({ dayLabel: label, date: this.ymdFromDate(d) });
    }
    return out;
  }

  private sortedSelectedDays(): string[] {
    const uniqueDays = Array.from(new Set(this.scheduleData.selectedDays));
    return uniqueDays.sort(
      (a, b) =>
        (SchedulingPage.DAY_SORT_ORDER[a] ?? 99) - (SchedulingPage.DAY_SORT_ORDER[b] ?? 99)
    );
  }

  // -------------------------------------------------------------------------
  // Repeat-mode UI helpers
  // -------------------------------------------------------------------------

  /** Called by the segment in the template; never set to an unknown mode. */
  setRepeatMode(mode: ScheduleRepeatMode): void {
    if (mode !== 'single' && mode !== 'whole_month') return;
    if (this.scheduleData.repeatMode === mode) return;
    this.scheduleData.repeatMode = mode;
    // Skips only make sense for whole_month and only against the currently
    // anchored month — easiest to drop them whenever the mode changes.
    this.scheduleData.excludedDates = [];
    this.calendarRemountKey += 1;
  }

  isRepeatMode(mode: ScheduleRepeatMode): boolean {
    return this.scheduleData.repeatMode === mode;
  }

  /**
   * Resolves the inclusive end-date for the active repeat mode. Returns ''
   * only when there is no selected start date.
   */
  private computeEffectiveEndYmd(): string {
    const start = this.scheduleData.selectedDate;
    if (!start) return '';
    switch (this.scheduleData.repeatMode) {
      case 'single':
        return start;
      case 'whole_month':
        return this.lastDayOfMonthYmd(start);
    }
  }

  /** Public-readable label for the small preview chip in the template. */
  getRepeatPreview(): string {
    if (
      !this.scheduleData.selectedDate ||
      this.scheduleData.selectedDays.length === 0 ||
      this.scheduleData.selectedChildren.length === 0
    ) {
      return '';
    }
    const entries = this.buildToSaveEntries();
    if (entries.length === 0) return '';
    const childCount = this.scheduleData.selectedChildren.length;
    const total = entries.length * childCount;
    const startLabel = this.getFormattedDate();

    if (this.scheduleData.repeatMode === 'single') {
      return `${total} pickup(s) for the date of ${startLabel}.`;
    }
    const last = entries[entries.length - 1].date;
    const endLabel = this.formatYmdShort(last);
    return `${total} pickup(s) — every selected weekday from ${startLabel} through ${endLabel}.`;
  }

  // -------------------------------------------------------------------------
  // Whole-month picker (Step 4 alternate UI)
  // -------------------------------------------------------------------------

  /** Lower bound for the month-year picker — same as the day calendar (today). */
  get wholeMonthMinIso(): string {
    return this.minDate;
  }

  /** Upper bound for the month-year picker — same as the day calendar (~1 yr). */
  get wholeMonthMaxIso(): string {
    return this.maxDate;
  }

  /**
   * `[value]` for the month-year `ion-datetime`. Anchored to the 1st at noon
   * of `selectedDate`'s month so the picker never DST-shifts to the previous
   * month at midnight in some locales.
   */
  get wholeMonthValueIso(): string {
    const ymd = this.scheduleData.selectedDate || this.minDate.split('T')[0];
    const [y, m] = String(ymd || '').split('-').map(Number);
    if (!y || !m) return '';
    const mm = String(m).padStart(2, '0');
    return `${y}-${mm}-01T12:00:00`;
  }

  /**
   * When the user picks a month, snap `selectedDate` to the **first selected
   * weekday in that month** that's still in `[today, maxDate]`. If no
   * matching weekday exists in the chosen month (e.g. the user picked the
   * current month but every matching day has already passed), keep the
   * previous selection and surface a friendly toast.
   */
  async onWholeMonthPicked(event: any): Promise<void> {
    const v = event?.detail?.value;
    if (!v) return;
    const m = String(v).match(/^(\d{4})-(\d{2})/);
    if (!m) return;
    const year = parseInt(m[1], 10);
    const month1 = parseInt(m[2], 10);
    if (Number.isNaN(year) || Number.isNaN(month1)) return;

    const ymd = this.firstAvailableDateInMonth(year, month1);
    if (!ymd) {
      await this.showToast(
        'No upcoming pickup days in that month. Pick a different month or change weekdays.'
      );
      return;
    }
    // Skips are scoped to a single month — clear them when the user moves to
    // another month so we don't silently retain "skip May 25" while showing June.
    this.scheduleData.excludedDates = [];
    this.scheduleData.selectedDate = ymd;
    this.calendarRemountKey += 1;
  }

  /**
   * First day in `(year, month1)` whose weekday is in `selectedDays` AND
   * lies inside `[minDate, maxDate]`. Used to anchor `selectedDate` after
   * the user picks a month from the month-year picker.
   */
  private firstAvailableDateInMonth(year: number, month1: number): string {
    if (this.scheduleData.selectedDays.length === 0) return '';
    const want = new Set(
      this.scheduleData.selectedDays.map((d) => this.labelToJsDay(d)).filter((n) => n >= 0)
    );
    const minPart = this.minDate.split('T')[0];
    const maxPart = this.maxDate.split('T')[0];
    const lastDay = new Date(year, month1, 0).getDate();
    for (let day = 1; day <= lastDay; day++) {
      const d = new Date(year, month1 - 1, day);
      if (!want.has(d.getDay())) continue;
      const ymd = this.ymdFromDate(d);
      if (ymd >= minPart && ymd <= maxPart) {
        return ymd;
      }
    }
    return '';
  }

  /**
   * Compact one-line summary of the dates that the whole-month schedule will
   * save, grouped by weekday. Examples:
   *   "May 2026 — Mon: 4, 11, 18, 25"
   *   "May 2026 — Mon: 4, 11, 18, 25 · Tue: 5, 12, 19, 26"
   */
  getWholeMonthDatesSummary(): string {
    if (!this.isRepeatMode('whole_month')) return '';
    if (
      !this.scheduleData.selectedDate ||
      this.scheduleData.selectedDays.length === 0
    ) {
      return '';
    }
    const entries = this.buildToSaveEntries();
    if (entries.length === 0) return '';

    const groups = new Map<string, number[]>();
    const order: string[] = [];
    for (const e of entries) {
      const [y, mo, day] = e.date.split('-').map(Number);
      if (!y || !mo || !day) continue;
      const dt = new Date(y, mo - 1, day);
      const key = dt.toLocaleDateString('en-US', { weekday: 'short' });
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(day);
    }

    const [yFirst, moFirst] = entries[0].date.split('-').map(Number);
    const monthLabel = new Date(yFirst, moFirst - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
    const parts = order.map(
      (dayName) => `${dayName}: ${groups.get(dayName)!.join(', ')}`
    );
    return `${monthLabel} — ${parts.join(' · ')}`;
  }

  /** Empty-state hint shown when no matching weekday exists in the picked month. */
  getWholeMonthEmptyHint(): string {
    if (!this.isRepeatMode('whole_month')) return '';
    if (this.scheduleData.selectedDays.length === 0) return '';
    if (!this.scheduleData.selectedDate) {
      return 'Pick a month above to see the dates that will be saved.';
    }
    const entries = this.buildToSaveEntries();
    if (entries.length > 0) return '';
    return 'No matching weekdays in that month yet. Try a different month or weekdays.';
  }

  private formatYmdShort(ymd: string): string {
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  private lastDayOfMonthYmd(ymd: string): string {
    const [y, m] = ymd.split('-').map(Number);
    if (!y || !m) return ymd;
    // Day 0 of the next month = last day of the current month (local time).
    const last = new Date(y, m, 0);
    return this.ymdFromDate(last);
  }

  private parseYmdLocal(ymd: string): Date | null {
    const [y, m, d] = String(ymd || '').split('-').map((n) => parseInt(n, 10));
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
    const dt = new Date(y, m - 1, d);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }


  private normalizeTimeStr(t: string): string {
    return String(t || '').trim();
  }

  /** Unique key: same calendar date + same time + same child => duplicate pickup */
  private pendingScheduleKey(date: string, time: string, childName: string): string {
    return `${date}|${this.normalizeTimeStr(time)}|${String(childName || '').trim()}`;
  }

  private async loadPendingScheduleKeysForFamily(
    familyName: string,
    excludeDocIds?: Set<string>
  ): Promise<Set<string>> {
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const q = query(schedulesCollection, where('Family Name', '==', familyName));
    const snap = await getDocs(q);
    const keys = new Set<string>();
    snap.forEach((docSnap) => {
      if (excludeDocIds?.has(docSnap.id)) {
        return;
      }
      const d = docSnap.data();
      const status = d['Status'] || 'pending';
      if (status !== 'pending') {
        return;
      }
      const date = String(d['Date'] || '');
      const time = this.normalizeTimeStr(d['Time'] || '');
      const child = String(d['Childs Name'] || '').trim();
      if (date && time && child) {
        keys.add(this.pendingScheduleKey(date, time, child));
      }
    });
    return keys;
  }

  /**
   * @returns Warning message if any proposed slot conflicts with an existing pending schedule, else null
   */
  private async checkConflictsWithExistingPending(
    toSave: { dayLabel: string; date: string }[],
    children: any[],
    time: string
  ): Promise<string | null> {
    const family = this.scheduleData.familyName;
    if (!family) {
      return null;
    }
    const exclude =
      this.editDocIds && this.editDocIds.length > 0 ? new Set(this.editDocIds) : undefined;
    const existing = await this.loadPendingScheduleKeysForFamily(family, exclude);
    const normTime = this.normalizeTimeStr(time);
    for (const entry of toSave) {
      for (const child of children) {
        const name = child.name || '';
        const k = this.pendingScheduleKey(entry.date, normTime, name);
        if (existing.has(k)) {
          return `A schedule already exists on ${entry.date} at ${normTime} for ${name}. Pick a different time or date.`;
        }
      }
    }
    return null;
  }

  async saveSchedule() {
    if (this.saveInProgress) {
      return;
    }

    if (!this.canManageSchedule) {
      await this.showToast('You do not have permission to create schedules');
      return;
    }

    if (!this.scheduleData.fetcherUID) {
      await this.showToast('Please select who will pick up first');
      return;
    }

    if (this.scheduleData.selectedDays.length === 0) {
      await this.showToast('Please select at least one day for this fetcher');
      return;
    }

    if (!this.scheduleData.selectedDate) {
      await this.showToast('Please select a date on the calendar');
      return;
    }

    const pickedDow = this.weekdayFromIonCalendarDay(this.scheduleData.selectedDate);
    const pickOk = this.scheduleData.selectedDays.some((d) => this.labelToJsDay(d) === pickedDow);
    if (!pickOk) {
      await this.showToast('Pick a date that matches one of your selected weekdays');
      return;
    }

    if (!this.scheduleData.selectedTime) {
      await this.showToast('Please select a time');
      return;
    }

    if (this.scheduleData.selectedChildren.length === 0) {
      await this.showToast('Please select at least one child');
      return;
    }

    const toSave = this.buildToSaveEntries();
    if (toSave.length === 0) {
      await this.showToast('No matching dates in the chosen range. Adjust days or dates.');
      return;
    }
    const conflictMessage = await this.checkConflictsWithExistingPending(
      toSave,
      this.scheduleData.selectedChildren,
      this.scheduleData.selectedTime
    );
    if (conflictMessage) {
      await this.showToast(conflictMessage);
      return;
    }

    const loading = await this.loadingController.create({
      message: this.isEditMode ? 'Updating schedule...' : 'Saving schedule...',
    });
    await loading.present();
    this.saveInProgress = true;

    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        await loading.dismiss();
        await this.showToast('User not authenticated');
        return;
      }

      const wasEdit = !!(this.editDocIds && this.editDocIds.length > 0);

      const schedulesCollection = collection(this.firestore, 'Schedules');

      const assign = {
        uid: this.scheduleData.fetcherUID,
        name: this.scheduleData.companionName || this.scheduleData.fetcherName,
      };

      const notifyByFetcher = new Map<
        string,
        { fetcherUid: string; fetcherName: string; days: Set<string>; dates: Set<string> }
      >();

      const buildDocPayload = (entry: { dayLabel: string; date: string }, child: any) => ({
        'Childs Grade': child.grade || '',
        'Childs Name': child.name || '',
        'Companions Name': assign.name,
        'Date': entry.date,
        'Parent Name': this.scheduleData.parentName,
        'Time': this.scheduleData.selectedTime,
        'Family Name': this.scheduleData.familyName,
        'Days': entry.dayLabel,
        'Fetcher UID': assign.uid,
        'Creator UID': currentUser.uid,
        'Created At': serverTimestamp(),
        'Status': 'pending',
        'Monthly repeat': false,
        'id': '',
      });

      for (const entry of toSave) {
        const key = assign.uid;
        if (!notifyByFetcher.has(key)) {
          notifyByFetcher.set(key, {
            fetcherUid: assign.uid,
            fetcherName: assign.name,
            days: new Set<string>(),
            dates: new Set<string>(),
          });
        }
        notifyByFetcher.get(key)!.days.add(entry.dayLabel);
        notifyByFetcher.get(key)!.dates.add(entry.date);
      }

      if (this.editDocIds && this.editDocIds.length > 0) {
        const batch = writeBatch(this.firestore);
        for (const id of this.editDocIds) {
          batch.delete(doc(this.firestore, 'Schedules', id));
        }
        const createdForReminders: Array<{
          id: string;
          dateYmd: string;
          childName: string;
        }> = [];
        for (const entry of toSave) {
          for (const child of this.scheduleData.selectedChildren) {
            const ref = doc(collection(this.firestore, 'Schedules'));
            batch.set(ref, buildDocPayload(entry, child));
            createdForReminders.push({
              id: ref.id,
              dateYmd: entry.date,
              childName: String(child?.name || '').trim(),
            });
          }
        }
        await batch.commit();
        this.editDocIds = null;
        this.isEditMode = false;
        if (String(currentUser.uid) === String(assign.uid)) {
          await Promise.all(
            createdForReminders.map((row) =>
              this.notificationService.schedulePickupReminder30m({
                scheduleId: row.id,
                familyName: this.scheduleData.familyName,
                childName: row.childName,
                scheduleDateYmd: row.dateYmd,
                scheduleTime: this.scheduleData.selectedTime,
              })
            )
          );
        }
      } else {
        const pairs: { entry: { dayLabel: string; date: string }; child: any }[] = [];
        for (const entry of toSave) {
          for (const child of this.scheduleData.selectedChildren) {
            pairs.push({ entry, child });
          }
        }
        const refs = await Promise.all(
          pairs.map(({ entry, child }) => addDoc(schedulesCollection, buildDocPayload(entry, child)))
        );
        if (String(currentUser.uid) === String(assign.uid)) {
          await Promise.all(
            refs.map((ref, i) =>
              this.notificationService.schedulePickupReminder30m({
                scheduleId: ref.id,
                familyName: this.scheduleData.familyName,
                childName: String(pairs[i].child?.name || '').trim(),
                scheduleDateYmd: pairs[i].entry.date,
                scheduleTime: this.scheduleData.selectedTime,
              })
            )
          );
        }
      }

      await this.sendScheduleNotifications(Array.from(notifyByFetcher.values()));

      await loading.dismiss();
      const totalDocs = toSave.length * this.scheduleData.selectedChildren.length;
      await this.showToast(
        wasEdit
          ? `Updated ${totalDocs} schedule document(s).`
          : `Saved ${totalDocs} schedule(s) for ${this.scheduleData.selectedChildren.length} child(ren).`
      );
      this.goBack();
    } catch (error) {
      await loading.dismiss();
      await this.showToast('Error saving schedule. Please try again.');
    } finally {
      this.saveInProgress = false;
    }
  }

  async sendScheduleNotifications(
    fetcherGroups: Array<{
      fetcherUid: string;
      fetcherName: string;
      days: Set<string>;
      dates: Set<string>;
    }>
  ) {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const childrenNames = this.scheduleData.selectedChildren.map((child) => child.name).join(', ');
      const childCount = this.scheduleData.selectedChildren.length;

      const notificationsCollection = collection(this.firestore, 'Notifications');
      for (const g of fetcherGroups) {
        const days = Array.from(g.days).sort(
          (a, b) =>
            (SchedulingPage.DAY_SORT_ORDER[a] ?? 99) - (SchedulingPage.DAY_SORT_ORDER[b] ?? 99)
        );
        const dates = Array.from(g.dates).sort();
        const dayLabel = days.join(', ');
        const datePart = dates.join(', ');
        const firstDate = dates[0] || '';

        const message = `You have been scheduled to pick up ${childrenNames} on ${dayLabel} at ${this.scheduleData.selectedTime}. Dates: ${datePart}.`;

        const notificationData = {
          type: 'schedule_assignment',
          title: 'New Schedule Assignment',
          message,
          recipientId: g.fetcherUid,
          senderId: currentUser.uid,
          senderName: currentUser.fullName || currentUser.email || 'Family Member',
          familyName: this.scheduleData.familyName,
          scheduleDate: firstDate || this.scheduleData.selectedDate,
          scheduleTime: this.scheduleData.selectedTime,
          scheduleDays: dayLabel,
          scheduleDatesList: dates,
          childrenNames: childrenNames,
          childrenCount: childCount,
          isRead: false,
          createdAt: serverTimestamp(),
        };

        await addDoc(notificationsCollection, notificationData);
      }
    } catch (error) {
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 3000,
      position: 'bottom',
    });
    await toast.present();
  }

  navigateTo(route: string) {
    this.router.navigate([route]);
  }

  goBack() {
    this.location.back();
  }

  async triggerPanic() {
    await this.panicService.triggerPanicAlert();
  }
}
