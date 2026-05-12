import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import {
  Firestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  deleteDoc,
  addDoc,
} from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { NotificationEmailForwardService } from '../services/notification-email-forward.service';
import { PickupNotificationLogLoaderService } from '../services/pickup-notification-log-loader.service';
import { NotificationFeedsBackgroundService } from '../services/notification-feeds-background.service';
import { LoadingController, ToastController } from '@ionic/angular';
import { Subscription } from 'rxjs';

import type { PickupLogNotificationRow as PickupNotification } from '../services/pickup-notification-log-loader.service';

const DISMISSED_SCAN_IDS_KEY = 'fetchsafe-notification-log-dismissed-scan-ids';
const DISMISSED_PICKUP_SCHEDULE_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-schedule-ids';
const DISMISSED_PICKUP_DOC_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-doc-ids';

@Component({
  selector: 'app-notification-log',
  templateUrl: './notification-log.page.html',
  styleUrls: ['./notification-log.page.scss'],
  standalone: false
})
export class NotificationLogPage implements OnInit, OnDestroy {
  /** All merged notifications (sorted newest-first). */
  private allNotifications: PickupNotification[] = [];

  /** Date-grouped notifications for the current page (10 items/page). */
  groupedNotifications: Array<{ dateLabel: string; items: PickupNotification[] }> = [];

  notificationPage = 1;
  readonly notificationPageSize = 10;

  isLoading: boolean = false;

  detailModalOpen = false;
  detailNotification: PickupNotification | null = null;
  detailBody = '';

  private familyNameForLog = '';
  private rowsSub = new Subscription();

  constructor(
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private notificationEmailForwardService: NotificationEmailForwardService,
    private pickupNotificationLogLoader: PickupNotificationLogLoaderService,
    private notificationFeedsBackground: NotificationFeedsBackgroundService,
    private loadingController: LoadingController,
    private toastController: ToastController
  ) {}

  async ngOnInit() {
    this.rowsSub.add(
      this.pickupNotificationLogLoader.rows$.subscribe((rows) => {
        this.allNotifications = rows;
        if (this.notificationPage > this.totalPages()) {
          this.notificationPage = this.totalPages();
        }
        this.rebuildGroupedNotifications();
      })
    );
    await this.createMissingNotificationLogs();
    await this.loadPickupNotifications();
  }

  async ionViewWillEnter() {
    await this.loadPickupNotifications({ silent: true });
  }

  ngOnDestroy(): void {
    this.rowsSub.unsubscribe();
  }

  async createMissingNotificationLogs() {
    try {
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      // Get all completed schedules for this family
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const completedSchedulesQuery = query(
        schedulesCollection,
        where('Family Name', '==', family.name),
        where('Status', '==', 'completed')
      );

      const schedulesSnapshot = await getDocs(completedSchedulesQuery);

      // Get existing notification logs for this family
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const existingLogsQuery = query(
        notificationsCollection,
        where('type', '==', 'pickup_completion'),
        where('familyName', '==', family.name)
      );

      const logsSnapshot = await getDocs(existingLogsQuery);
      const existingScheduleIds = new Set();

      logsSnapshot.forEach((doc) => {
        const data = doc.data();
        if (data['scheduleId']) {
          existingScheduleIds.add(data['scheduleId']);
        }
      });

      const dismissedSchedules = this.loadDismissedPickupScheduleIds();
      let createdCount = 0;
      for (const scheduleDoc of schedulesSnapshot.docs) {
        const scheduleId = scheduleDoc.id;
        const scheduleData = scheduleDoc.data();

        if (!existingScheduleIds.has(scheduleId) && !dismissedSchedules.has(scheduleId)) {
          const childLabel = scheduleData['Childs Name'] || 'Child';
          const fetcherLabel = scheduleData['Completed By'] || 'Unknown';
          const notificationData = {
            type: 'pickup_completion',
            // Match the new wording surfaced everywhere else in the Pick Up Log.
            title: `${childLabel} was picked up by ${fetcherLabel}`,
            message: `${childLabel} was picked up by ${fetcherLabel}.`,
            childName: scheduleData['Childs Name'] || 'Unknown Child',
            completedBy: fetcherLabel,
            familyName: scheduleData['Family Name'] || family.name,
            scheduleId: scheduleId,
            scheduleDate: scheduleData['Date'] || '',
            scheduleTime: scheduleData['Time'] || '',
            isRead: false,
            createdAt: scheduleData['Completed At'] || new Date()
          };

          await addDoc(notificationsCollection, notificationData);
          createdCount++;
        }
      }

      if (createdCount > 0) {
        await this.loadPickupNotifications();
      } else {
      }

    } catch (error) {
    }
  }



  async loadPickupNotifications(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    try {
      if (!silent) {
        this.isLoading = true;
      }
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return;
      }
      const family = await this.familyService.getUserFamily();
      if (!family) {
        return;
      }
      this.familyNameForLog = family.name;
      await this.notificationFeedsBackground.ensureRunning();
      await this.pickupNotificationLogLoader.refreshNow(family.name);
      const merged = this.pickupNotificationLogLoader.rows$.value;
      if (currentUser.email && this.notificationEmailForwardService.isEmailForwardingEnabled()) {
        await this.notificationEmailForwardService.forwardNewNotifications(
          merged.map((n) => ({
            id: n.id,
            title: n.title,
            displayMessage: this.buildDetailBody(n),
            time: this.detailTimestamp(n),
            type: n.type,
          }))
        );
      }
    } catch {
      /* noop */
    } finally {
      if (!silent) {
        this.isLoading = false;
      }
    }
  }

  private loadDismissedScanIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_SCAN_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  private saveDismissedScanIds(ids: Set<string>) {
    localStorage.setItem(DISMISSED_SCAN_IDS_KEY, JSON.stringify([...ids]));
  }

  private loadDismissedPickupScheduleIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_PICKUP_SCHEDULE_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  private saveDismissedPickupScheduleIds(ids: Set<string>) {
    localStorage.setItem(DISMISSED_PICKUP_SCHEDULE_IDS_KEY, JSON.stringify([...ids]));
  }

  private loadDismissedPickupDocIds(): Set<string> {
    try {
      const raw = localStorage.getItem(DISMISSED_PICKUP_DOC_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  private saveDismissedPickupDocIds(ids: Set<string>) {
    localStorage.setItem(DISMISSED_PICKUP_DOC_IDS_KEY, JSON.stringify([...ids]));
  }

  private rebuildGroupedNotifications(): void {
    const start = (this.notificationPage - 1) * this.notificationPageSize;
    const end = start + this.notificationPageSize;
    const pageItems = this.allNotifications.slice(start, end);

    const groups = new Map<string, PickupNotification[]>();
    for (const n of pageItems) {
      const d = n.createdAt?.toDate ? n.createdAt.toDate() : new Date(n.createdAt);
      const label = Number.isNaN(d.getTime())
        ? 'Unknown date'
        : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(n);
    }

    // Preserve page order (newest-first) by iterating in encounter order.
    const out: Array<{ dateLabel: string; items: PickupNotification[] }> = [];
    for (const n of pageItems) {
      const d = n.createdAt?.toDate ? n.createdAt.toDate() : new Date(n.createdAt);
      const label = Number.isNaN(d.getTime())
        ? 'Unknown date'
        : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      if (!out.some((g) => g.dateLabel === label)) {
        out.push({ dateLabel: label, items: groups.get(label) ?? [] });
      }
    }
    this.groupedNotifications = out;
  }

  totalPages(): number {
    const n = this.allNotifications.length;
    return n > 0 ? Math.ceil(n / this.notificationPageSize) : 1;
  }

  pageLabel(): string {
    if (!this.allNotifications.length) return '';
    return `Page ${this.notificationPage} of ${this.totalPages()}`;
  }

  canPrev(): boolean {
    return this.notificationPage > 1;
  }

  canNext(): boolean {
    return this.notificationPage < this.totalPages();
  }

  prevPage(): void {
    if (!this.canPrev()) return;
    this.notificationPage -= 1;
    this.rebuildGroupedNotifications();
  }

  nextPage(): void {
    if (!this.canNext()) return;
    this.notificationPage += 1;
    this.rebuildGroupedNotifications();
  }

  isSameDay(date1: Date, date2: Date): boolean {
    return date1.getDate() === date2.getDate() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getFullYear() === date2.getFullYear();
  }

  formatTime(timestamp: any): string {
    if (!timestamp) return 'Unknown';

    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (error) {
      return 'Unknown';
    }
  }

  /**
   * Schedules often store clock as "21:38" or "21:38:00" (24h). Show 12h AM/PM in the log.
   */
  private formatStoredClockTo12h(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return s;
    let h = parseInt(m[1], 10);
    const min = m[2];
    if (Number.isNaN(h) || h < 0 || h > 23) return s;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${min} ${ampm}`;
  }

  async dismissNotification(notification: PickupNotification, ev?: Event) {
    ev?.stopPropagation();
    ev?.preventDefault();
    const notificationId = notification.id;
    try {
      if (notificationId.startsWith('scan_')) {
        const scanDocId = notificationId.replace(/^scan_/, '');
        const dismissed = this.loadDismissedScanIds();
        dismissed.add(scanDocId);
        this.saveDismissedScanIds(dismissed);
      } else {
        const sid = String(notification.scheduleId || '').trim();
        if (sid) {
          const dismissedS = this.loadDismissedPickupScheduleIds();
          dismissedS.add(sid);
          this.saveDismissedPickupScheduleIds(dismissedS);
        } else {
          const dismissedD = this.loadDismissedPickupDocIds();
          dismissedD.add(notificationId);
          this.saveDismissedPickupDocIds(dismissedD);
        }
        try {
          const notificationDoc = doc(this.firestore, 'Notifications', notificationId);
          await deleteDoc(notificationDoc);
        } catch (delErr) {
        }
      }

      if (this.familyNameForLog) {
        await this.pickupNotificationLogLoader.refreshNow(this.familyNameForLog);
      }

      await this.showToast('Notification dismissed');
    } catch (error) {
      await this.showToast('Error dismissing notification');
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 2000,
      position: 'bottom'
    });
    await toast.present();
  }

  
  navigateToHome() {
    this.router.navigate(['/home']);
  }

  navigateToFamily() {
    this.router.navigate(['/created-family']);
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }

  async triggerPanicAlert() {
    await this.panicService.triggerPanicAlert();
  }



  onNotificationClick(notification: PickupNotification) {
    this.detailNotification = notification;
    this.detailBody = this.buildDetailBody(notification);
    this.detailModalOpen = true;
  }

  closeDetailModal(): void {
    this.detailModalOpen = false;
  }

  onDetailModalDismiss(): void {
    this.detailModalOpen = false;
    this.detailNotification = null;
    this.detailBody = '';
  }

  detailTimestamp(n: PickupNotification | null): string {
    if (!n?.createdAt) {
      return n?.time || '';
    }
    try {
      const d = n.createdAt.toDate ? n.createdAt.toDate() : new Date(n.createdAt);
      if (Number.isNaN(d.getTime())) {
        return n.time || '';
      }
      return d.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return n.time || '';
    }
  }

  private buildDetailBody(n: PickupNotification): string {
    const raw = (n.message || '').trim();
    if (raw && n.source !== 'scan_event') {
      return raw;
    }
    if (n.source === 'scan_event') {
      const lines = [
        n.scanAction === 'Entered' ? 'School check-in' : 'School check-out',
        n.title,
        n.subtitle,
        `Time: ${this.detailTimestamp(n)}`,
      ].filter(Boolean);
      return lines.join('\n\n');
    }
    const lines = [
      `Child: ${n.childName || ''}`.trim(),
      `Picked up by: ${n.completedBy || ''}`.trim(),
      n.scheduleTime ? `Scheduled time: ${this.formatStoredClockTo12h(n.scheduleTime)}` : '',
      `Recorded: ${n.time || ''}`.trim(),
      n.date ? `Date: ${n.date}` : '',
      (n.subtitle || '').trim() ? n.subtitle : '',
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  /** Template: icon name per row */
  logIconName(n: PickupNotification): string {
    if (n.source === 'scan_event') {
      return n.scanAction === 'Entered' ? 'log-in-outline' : 'log-out-outline';
    }
    return 'checkmark-circle';
  }

  logIconClass(n: PickupNotification): string {
    if (n.source === 'scan_event') {
      return n.scanAction === 'Entered' ? 'teal' : 'success';
    }
    return 'blue';
  }
}
