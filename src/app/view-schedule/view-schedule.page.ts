import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Firestore, collection, query, where, getDocs, orderBy, doc, updateDoc, addDoc, serverTimestamp, deleteDoc } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService, FamilyMember } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { NotificationService } from '../services/notification.service';
import { LoadingController, ToastController, AlertController } from '@ionic/angular';
import { RoleAccessService, UserRole } from '../services/role-access.service';
import { ScheduleExitScanSyncService } from '../services/schedule-exit-scan-sync.service';
import { OfflineCacheKeys, OfflineCacheService } from '../services/offline-cache.service';

interface ScheduleItem {
  id: string;
  date: string;
  time: string;
  days: string;
  fetcherName: string;
  fetcherUID: string;
  companionName: string;
  parentName: string;
  childName: string;
  childGrade: string;
  familyName: string;
  createdAt: any;
  status?: string;
  completedAt?: any;
  completedBy?: string;
  /** Extra Firestore docs merged into this row (same pickup); completed together */
  duplicateDocIds?: string[];
}

@Component({
  selector: 'app-view-schedule',
  templateUrl: './view-schedule.page.html',
  styleUrls: ['./view-schedule.page.scss'],
  standalone: false
})
export class ViewSchedulePage implements OnInit {
  schedules: ScheduleItem[] = [];
  isLoading: boolean = true;
  familyName: string = '';
  userRole: UserRole | null = null;
  /** Pickers for inline edit (parents/owners only) */
  familyMembers: FamilyMember[] = [];
  children: any[] = [];
  editingScheduleId: string | null = null;
  editFetcherUID = '';
  editChildName = '';
  /** HH:mm for ion-input type="time" */
  editTime = '';
  savingInlineEdit = false;
  showingOfflineSchedules = false;
  private autoCompleteInterval: any;

  constructor(
    private location: Location,
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private notificationService: NotificationService,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private alertController: AlertController,
    private roleAccessService: RoleAccessService,
    private scheduleExitScanSync: ScheduleExitScanSyncService,
    private offlineCache: OfflineCacheService
  ) { }

  async ngOnInit() {
    this.hydrateRoleFromCache();
    this.hydrateSchedulesFromCache();
    this.startAutomaticScheduleCompletion();
  }

  /** Reload from Firestore whenever the page is shown (tab/back from scheduling), not only on first create. */
  async ionViewWillEnter() {
    this.hydrateRoleFromCache();
    const hadCachedSchedules = this.hydrateSchedulesFromCache();
    await this.loadScheduleData(!hadCachedSchedules);
  }

  private hydrateRoleFromCache(): void {
    this.roleAccessService.applyUserRole((role) => {
      this.userRole = role;
    });
  }

  private hydrateSchedulesFromCache(): boolean {
    const familyName =
      this.familyName ||
      this.userRole?.familyName ||
      this.roleAccessService.getCachedUserRole()?.familyName ||
      '';
    if (!familyName) {
      return false;
    }
    const cached = this.offlineCache.load<ScheduleItem[]>(OfflineCacheKeys.schedules(familyName));
    if (!cached?.length) {
      return false;
    }
    this.familyName = familyName;
    this.schedules = cached;
    this.isLoading = false;
    this.showingOfflineSchedules = !this.offlineCache.isOnline();
    return true;
  }

  startAutomaticScheduleCompletion() {
    this.autoCompleteInterval = setInterval(async () => {
      await this.checkAndCompleteOverdueSchedules();
    }, 60000); 

   
    setTimeout(async () => {
      await this.checkAndCompleteOverdueSchedules();
    }, 5000); 
  }

  ngOnDestroy() {
    
    if (this.autoCompleteInterval) {
      clearInterval(this.autoCompleteInterval);
    }
  }

  async checkAndCompleteOverdueSchedules() {
    try {
      await this.loadScheduleData(false);
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes(); 
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`;
      const schedulesToComplete = [];

      for (const schedule of this.schedules) {
        
        const scheduleDate = this.toLocalYmd(schedule.date);

        if (scheduleDate === today) {
          
          const scheduleTimeMinutes = this.parseScheduleTimeToMinutesSafe(schedule.time);

          
          if (currentTime > scheduleTimeMinutes) {
            schedulesToComplete.push(schedule);
          }
        }
      }

      
      for (const schedule of schedulesToComplete) {
        await this.automaticallyCompleteSchedule(schedule);
      }

    } catch (error) {
    }
  }

  
  parseTimeToMinutes(timeString: string): number {
    try {
      const raw = timeString.trim().split(/\s+/);
      const time = raw[0];
      const period = (raw[1] || '').toUpperCase();
      const [hours, minutes] = time.split(':').map(Number);

      let totalHours = hours;
      if (period === 'PM' && hours !== 12) {
        totalHours += 12;
      } else if (period === 'AM' && hours === 12) {
        totalHours = 0;
      }

      return totalHours * 60 + minutes;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Minutes from midnight for sorting (fractional if seconds present).
   * Handles 24h HH:mm / HH:mm:ss from ion-input and "h:mm AM/PM" (any case, optional space).
   */
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
      if (ap === 'PM' && h !== 12) {
        h += 12;
      }
      if (ap === 'AM' && h === 12) {
        h = 0;
      }
      return h * 60 + m + s / 60;
    }

    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      const h = parseInt(h24[1], 10);
      const m = parseInt(h24[2], 10);
      const s = h24[3] != null ? parseInt(h24[3], 10) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(m)) {
        return h * 60 + m + s / 60;
      }
    }

    if (/\b(AM|PM)\b/i.test(t)) {
      return this.parseTimeToMinutes(t);
    }
    return 0;
  }

  private toLocalYmd(dateStr: string): string {
    const parts = dateStr.split('-').map((n) => parseInt(n, 10));
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const [y, m, d] = parts;
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  private scheduleSortTimestamp(s: ScheduleItem): number {
    const parts = s.date.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return 0;
    }
    const [y, mo, d] = parts;
    const dayStart = new Date(y, mo - 1, d).getTime();
    return dayStart + this.parseScheduleTimeToMinutesSafe(s.time) * 60 * 1000;
  }

  /** Earliest pickup first: date, then clock time — never creation / Firestore order */
  private compareSchedulesChronologically(a: ScheduleItem, b: ScheduleItem): number {
    const ta = this.scheduleSortTimestamp(a);
    const tb = this.scheduleSortTimestamp(b);
    if (ta !== tb) {
      return ta - tb;
    }
    const minDiff =
      this.parseScheduleTimeToMinutesSafe(a.time) - this.parseScheduleTimeToMinutesSafe(b.time);
    if (minDiff !== 0) {
      return minDiff;
    }
    return String(a.time).localeCompare(String(b.time));
  }

  private createdAtMs(v: any): number {
    if (v == null) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    return 0;
  }

  private scheduleDedupeKey(s: ScheduleItem): string {
    return `${this.toLocalYmd(s.date)}|${String(s.time || '').trim()}|${String(s.childName || '').trim()}|${s.fetcherUID}|${String(s.days || '').trim()}`;
  }

  /** One row per logical pickup; duplicate Firestore writes collapse here */
  private mergeDuplicateSchedules(items: ScheduleItem[]): ScheduleItem[] {
    const groups = new Map<string, ScheduleItem[]>();
    for (const s of items) {
      const k = this.scheduleDedupeKey(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    const out: ScheduleItem[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        out.push(group[0]);
        continue;
      }
      group.sort((a, b) => this.createdAtMs(b.createdAt) - this.createdAtMs(a.createdAt));
      const [primary, ...rest] = group;
      out.push({
        ...primary,
        duplicateDocIds: rest.map((r) => r.id),
      });
    }
    return out;
  }

  private allScheduleDocIds(s: ScheduleItem): string[] {
    return [s.id, ...(s.duplicateDocIds || [])];
  }

  async automaticallyCompleteSchedule(schedule: ScheduleItem) {
    try {
  
      
      const completedBy = schedule.fetcherName || 'Unknown Fetcher';

      
      const docIds = this.allScheduleDocIds(schedule);
      for (const docId of docIds) {
        const scheduleDoc = doc(this.firestore, 'Schedules', docId);
        await updateDoc(scheduleDoc, {
          'Status': 'completed',
          'Completed At': serverTimestamp(),
          'Completed By': completedBy
        });
      }

      
      await this.createAutomaticPickupNotificationLog(schedule, completedBy);

      
      await this.sendAutomaticCapacitorNotification(schedule);

      
      const scheduleIndex = this.schedules.findIndex(s => s.id === schedule.id);
      if (scheduleIndex !== -1) {
        this.schedules.splice(scheduleIndex, 1);
      }

    } catch (error) {
    }
  }

  async loadScheduleData(showLoadingIfEmpty = true) {
    const hasContent = this.schedules.length > 0;
    if (showLoadingIfEmpty && !hasContent) {
      this.isLoading = true;
    }
    try {
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        return;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        return;
      }

      this.familyName = family.name;
      const cacheKey = OfflineCacheKeys.schedules(family.name);

      const result = await this.offlineCache.loadWithOfflineFallback(cacheKey, async () => {
        if (this.offlineCache.isOnline()) {
          await this.scheduleExitScanSync.syncExitScansToCompletedSchedules(family.name);
        }
        return this.fetchPendingSchedules(family.name);
      });

      this.schedules = result.data;
      this.showingOfflineSchedules = result.fromCache;

      if (!result.fromCache) {
        await this.loadFamilyPickersForEdit();
        await this.notificationService.syncPendingPickupReminders30mForCurrentUser({
          force: hasContent,
        });
      }

    } catch (error) {
    } finally {
      this.isLoading = false;
    }
  }

  private async fetchPendingSchedules(familyName: string): Promise<ScheduleItem[]> {
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const familySchedulesQuery = query(
      schedulesCollection,
      where('Family Name', '==', familyName)
    );

    const querySnapshot = await getDocs(familySchedulesQuery);
    const rows: ScheduleItem[] = [];

    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const scheduleStatus = data['Status'] || 'pending';
      if (scheduleStatus !== 'pending') {
        return;
      }
      rows.push({
        id: docSnap.id,
        date: data['Date'] || '',
        time: data['Time'] || '',
        days: data['Days'] || '',
        fetcherName: data['Companions Name'] || '',
        fetcherUID: data['Fetcher UID'] || '',
        companionName: data['Companions Name'] || '',
        parentName: data['Parent Name'] || '',
        childName: data['Childs Name'] || '',
        childGrade: data['Childs Grade'] || '',
        familyName: data['Family Name'] || '',
        createdAt: data['Created At'],
        status: scheduleStatus,
        completedAt: data['Completed At'],
        completedBy: data['Completed By'],
      });
    });

    const merged = this.mergeDuplicateSchedules(rows);
    merged.sort((a, b) => this.compareSchedulesChronologically(a, b));
    return merged;
  }

  getFormattedDate(dateString: string): string {
    if (!dateString) return '';

    const parts = dateString.split('-').map(Number);
    if (parts.length === 3 && !parts.some(Number.isNaN)) {
      const [y, m, d] = parts;
      return new Date(y, m - 1, d).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }

    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  getFormattedTime(timeString: string): string {
    if (!timeString) return '';

    
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;

    return `${displayHour}:${minutes} ${ampm}`;
  }

  async createAutomaticPickupNotificationLog(schedule: ScheduleItem, completedBy: string) {
    try {
      const pickupNotificationData = {
        type: 'pickup_completion',
        title: `${schedule.childName} picked up`,
        message: `${schedule.childName} was automatically marked as picked up at scheduled time`,
        childName: schedule.childName,
        childGrade: schedule.childGrade,
        fetcherName: schedule.fetcherName,
        completedBy: completedBy,
        familyName: schedule.familyName,
        scheduleId: schedule.id,
        scheduleDate: schedule.date,
        scheduleTime: schedule.time,
        scheduleDays: schedule.days,
        isRead: false,
        createdAt: serverTimestamp()
      };

      const notificationsCollection = collection(this.firestore, 'Notifications');
      const docRef = await addDoc(notificationsCollection, pickupNotificationData);
    } catch (error) {
    }
  }

  async sendAutomaticCapacitorNotification(schedule: ScheduleItem) {
    try {
      const title = 'Schedule Auto-Completed';
      const message = `${schedule.childName} pickup time has passed - automatically marked as completed`;

      await this.notificationService.sendScheduleNotification(
        title,
        message,
        schedule.familyName
      );
    } catch (error) {
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 3000,
      position: 'bottom'
    });
    await toast.present();
  }

  isScheduleCompleted(schedule: ScheduleItem): boolean {
    return schedule.status === 'completed';
  }

  goBack() {
    this.location.back();
  }

  navigateTo(route: string) {
    this.router.navigate([route]);
  }

  canEditOrDeleteSchedule(): boolean {
    return !!(this.userRole?.canAccessScheduling);
  }

  isEditing(schedule: ScheduleItem): boolean {
    return this.editingScheduleId === schedule.id;
  }

  private async loadFamilyPickersForEdit(): Promise<void> {
    if (!this.familyName) {
      return;
    }
    try {
      this.familyMembers = await this.familyService.getFamilyMembers(this.familyName);
      this.children = await this.familyService.getFamilyChildren(this.familyName);
    } catch (e) {
      this.familyMembers = [];
      this.children = [];
    }
  }

  getFetchersForEdit(): FamilyMember[] {
    const eligible = this.familyMembers.filter(
      (m) => m.role === 'owner' || m.role === 'parent' || m.role === 'companion'
    );
    const byUid = new Map<string, FamilyMember>();
    for (const m of eligible) {
      byUid.set(m.uid, m);
    }
    const cu = this.authService.getCurrentUser();
    if (
      cu &&
      this.userRole &&
      !byUid.has(cu.uid) &&
      (this.userRole.role === 'owner' || this.userRole.role === 'parent')
    ) {
      byUid.set(cu.uid, {
        id: cu.uid,
        uid: cu.uid,
        name: cu.fullName || cu.email || 'Me',
        email: cu.email || '',
        contactNumber: cu.contactNumber || '',
        role: this.userRole.role as FamilyMember['role'],
        joinedDate: null,
      });
    }
    return Array.from(byUid.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }

  /** Normalize stored time to HH:mm for ion-input[type=time] */
  private normalizeTimeForInput(time: string): string {
    const t = (time || '').trim();
    if (!t) {
      return '00:00';
    }
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = ampm[2];
      const ap = ampm[3].toUpperCase();
      if (ap === 'PM' && h !== 12) {
        h += 12;
      }
      if (ap === 'AM' && h === 12) {
        h = 0;
      }
      return `${String(h).padStart(2, '0')}:${m}`;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})/);
    if (h24) {
      const h = Math.min(23, Math.max(0, parseInt(h24[1], 10)));
      return `${String(h).padStart(2, '0')}:${h24[2]}`;
    }
    return '00:00';
  }

  async startInlineEdit(schedule: ScheduleItem): Promise<void> {
    if (!this.canEditOrDeleteSchedule() || this.isScheduleCompleted(schedule)) {
      return;
    }
    if (!this.familyMembers.length && this.familyName) {
      await this.loadFamilyPickersForEdit();
    }
    if (!this.getFetchersForEdit().length) {
      await this.showToast('No fetchers available to assign.');
      return;
    }
    if (!this.children.length) {
      await this.showToast('No children found for this family.');
      return;
    }
    this.editingScheduleId = schedule.id;
    this.editFetcherUID = schedule.fetcherUID || '';
    this.editChildName = schedule.childName || '';
    this.editTime = this.normalizeTimeForInput(schedule.time);
  }

  cancelInlineEdit(): void {
    this.editingScheduleId = null;
  }

  async saveInlineEdit(schedule: ScheduleItem): Promise<void> {
    if (this.savingInlineEdit || !this.isEditing(schedule)) {
      return;
    }
    const fetcher = this.getFetchersForEdit().find((f) => f.uid === this.editFetcherUID);
    const child = this.children.find((c) => c.name === this.editChildName);
    if (!fetcher) {
      await this.showToast('Select an assigned fetcher');
      return;
    }
    if (!child) {
      await this.showToast('Select a child');
      return;
    }
    const timeToStore = (this.editTime || '').trim();
    if (!timeToStore) {
      await this.showToast('Set a pickup time');
      return;
    }

    this.savingInlineEdit = true;
    const loading = await this.loadingController.create({ message: 'Saving changes...' });
    await loading.present();
    try {
      const updates = {
        'Companions Name': fetcher.name,
        'Fetcher UID': fetcher.uid,
        'Childs Name': child.name,
        'Childs Grade': child.grade || '',
        'Time': timeToStore,
      };
      for (const id of this.allScheduleDocIds(schedule)) {
        await updateDoc(doc(this.firestore, 'Schedules', id), updates);
      }
      schedule.fetcherName = fetcher.name;
      schedule.fetcherUID = fetcher.uid;
      schedule.companionName = fetcher.name;
      schedule.childName = child.name;
      schedule.childGrade = child.grade || '';
      schedule.time = timeToStore;
      this.editingScheduleId = null;
      this.schedules.sort((a, b) => this.compareSchedulesChronologically(a, b));
      await this.showToast('Schedule updated');
    } catch (e) {
      await this.showToast('Could not save changes. Try again.');
    } finally {
      await loading.dismiss();
      this.savingInlineEdit = false;
    }
  }

  async confirmDeleteSchedule(schedule: ScheduleItem): Promise<void> {
    if (!this.canEditOrDeleteSchedule() || this.isScheduleCompleted(schedule)) {
      return;
    }
    const alert = await this.alertController.create({
      header: 'Delete schedule?',
      message: `Remove pickup for ${schedule.childName} on ${this.getFormattedDate(schedule.date)} at ${this.getFormattedTime(schedule.time)}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => {
            void this.deleteSchedule(schedule);
          },
        },
      ],
    });
    await alert.present();
  }

  private async deleteSchedule(schedule: ScheduleItem): Promise<void> {
    const loading = await this.loadingController.create({ message: 'Deleting schedule...' });
    await loading.present();
    try {
      for (const id of this.allScheduleDocIds(schedule)) {
        await deleteDoc(doc(this.firestore, 'Schedules', id));
      }
      const idx = this.schedules.findIndex((s) => s.id === schedule.id);
      if (idx !== -1) {
        this.schedules.splice(idx, 1);
      }
      await this.showToast('Schedule deleted');
    } catch (e) {
      await this.showToast('Could not delete schedule. Try again.');
    } finally {
      await loading.dismiss();
    }
  }

  async triggerPanic() {
    await this.panicService.triggerPanicAlert();
  }
}
