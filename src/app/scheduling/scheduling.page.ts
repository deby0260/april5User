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
import { LoadingController, ToastController } from '@ionic/angular';
import { RoleAccessService } from '../services/role-access.service';
import type { DatetimeHighlightCallback } from '@ionic/core';

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
    private roleAccessService: RoleAccessService
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

    this.scheduleAccessLoading = true;
    try {
      // Family data and role do not depend on each other for first paint; parallel is faster than sequential awaits
      await Promise.all([this.loadFamilyData(), this.loadUserRole()]);
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
    const match = this.children.find((c) => c.name === state.childName);
    this.scheduleData.selectedChildren = match
      ? [match]
      : [{ name: state.childName, grade: state.childGrade || '' }];
    this.calendarRemountKey += 1;
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
    this.syncSelectedDateAfterDaysChange();
    this.calendarRemountKey += 1;
  }

  onDateChange(event: any) {
    const selectedDate = event.detail.value;
    if (selectedDate) {
      this.scheduleData.selectedDate = String(selectedDate).split('T')[0];
    }
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
      backgroundColor: 'rgba(18, 156, 174, 0.22)',
      textColor: '#0f2d2f',
    };
  };

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

  /** One row per selected weekday, all in the same Mon-start week as selectedDate */
  private buildToSaveEntries(): { dayLabel: string; date: string }[] {
    const monday = this.mondayOfWeekContaining(this.scheduleData.selectedDate);
    const uniqueDays = Array.from(new Set(this.scheduleData.selectedDays));
    const sorted = uniqueDays.sort(
      (a, b) =>
        (SchedulingPage.DAY_SORT_ORDER[a] ?? 99) - (SchedulingPage.DAY_SORT_ORDER[b] ?? 99)
    );
    const out: { dayLabel: string; date: string }[] = [];
    for (const label of sorted) {
      const off = SchedulingPage.LABEL_TO_MONDAY_OFFSET[label];
      if (off === undefined) continue;
      const d = new Date(monday);
      d.setDate(monday.getDate() + off);
      out.push({ dayLabel: label, date: this.ymdFromDate(d) });
    }
    return out;
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
        for (const entry of toSave) {
          for (const child of this.scheduleData.selectedChildren) {
            const ref = doc(collection(this.firestore, 'Schedules'));
            batch.set(ref, buildDocPayload(entry, child));
          }
        }
        await batch.commit();
        this.editDocIds = null;
        this.isEditMode = false;
      } else {
        const schedulePromises: Promise<unknown>[] = [];
        for (const entry of toSave) {
          for (const child of this.scheduleData.selectedChildren) {
            schedulePromises.push(addDoc(schedulesCollection, buildDocPayload(entry, child)));
          }
        }
        await Promise.all(schedulePromises);
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
