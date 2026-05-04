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
  onSnapshot,
} from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { LoadingController, ToastController } from '@ionic/angular';

const DISMISSED_SCAN_IDS_KEY = 'fetchsafe-notification-log-dismissed-scan-ids';
/** User hid a pickup row; prevents createMissingNotificationLogs from re-adding it */
const DISMISSED_PICKUP_SCHEDULE_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-schedule-ids';
/** Legacy pickup docs with no scheduleId — hide by Firestore doc id */
const DISMISSED_PICKUP_DOC_IDS_KEY = 'fetchsafe-notification-log-dismissed-pickup-doc-ids';

interface PickupNotification {
  id: string;
  time: string;
  date?: string;
  title: string;
  subtitle: string;
  childName: string;
  fetcherName: string;
  completedBy: string;
  scheduleTime?: string;
  /** Links pickup_completion log to Schedules doc; used to hide dismissed rows without them coming back */
  scheduleId?: string;
  createdAt: any;
  type: string;
  /** Full body when stored on the doc (e.g. announcements, panic copy) */
  message?: string;
  /** From admin QR scan (`ScanEvents`); drives labels like arrived / picked up */
  source?: 'notification' | 'scan_event';
  scanAction?: 'Entered' | 'Exited';
  /** Firestore document id when source === 'scan_event' */
  scanEventDocId?: string;
}

@Component({
  selector: 'app-notification-log',
  templateUrl: './notification-log.page.html',
  styleUrls: ['./notification-log.page.scss'],
  standalone: false
})
export class NotificationLogPage implements OnInit, OnDestroy {
  todayNotifications: PickupNotification[] = [];
  yesterdayNotifications: PickupNotification[] = [];
  olderNotifications: PickupNotification[] = [];
  isLoading: boolean = false;

  detailModalOpen = false;
  detailNotification: PickupNotification | null = null;
  detailBody = '';

  private pickupLogUnsubs: Array<() => void> = [];
  private pickupLogRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private loadingController: LoadingController,
    private toastController: ToastController
  ) { }

  async ngOnInit() {
    await this.loadPickupNotifications();

    await this.createMissingNotificationLogs();
  }

  /** Subscribe to Firestore while this tab is visible so new scans / notifications appear without leaving the page. */
  async ionViewWillEnter() {
    await this.startPickupLogRealtime();
  }

  ionViewWillLeave() {
    this.stopPickupLogRealtime();
  }

  ngOnDestroy(): void {
    this.stopPickupLogRealtime();
  }

  private stopPickupLogRealtime(): void {
    if (this.pickupLogRefreshTimer != null) {
      clearTimeout(this.pickupLogRefreshTimer);
      this.pickupLogRefreshTimer = null;
    }
    for (const unsub of this.pickupLogUnsubs) {
      try {
        unsub();
      } catch {
        /* noop */
      }
    }
    this.pickupLogUnsubs = [];
  }

  private schedulePickupLogRefresh(): void {
    if (this.pickupLogRefreshTimer != null) {
      clearTimeout(this.pickupLogRefreshTimer);
    }
    this.pickupLogRefreshTimer = setTimeout(() => {
      this.pickupLogRefreshTimer = null;
      void this.loadPickupNotifications({ silent: true });
    }, 200);
  }

  private async startPickupLogRealtime(): Promise<void> {
    this.stopPickupLogRealtime();
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return;
    }
    const family = await this.familyService.getUserFamily();
    if (!family) {
      return;
    }

    const notificationsCollection = collection(this.firestore, 'Notifications');
    const qPickups = query(
      notificationsCollection,
      where('type', '==', 'pickup_completion'),
      where('familyName', '==', family.name)
    );
    const eventsCol = collection(this.firestore, 'ScanEvents');
    const qScans = query(eventsCol, where('familyName', '==', family.name));

    this.pickupLogUnsubs.push(
      onSnapshot(
        qPickups,
        () => this.schedulePickupLogRefresh(),
        (err) => console.warn('Pickup log: Notifications listener', err)
      )
    );
    this.pickupLogUnsubs.push(
      onSnapshot(
        qScans,
        () => this.schedulePickupLogRefresh(),
        (err) => console.warn('Pickup log: ScanEvents listener', err)
      )
    );
  }

  async createMissingNotificationLogs() {
    try {
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      console.log('Checking for completed schedules without notification logs...');

      // Get all completed schedules for this family
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const completedSchedulesQuery = query(
        schedulesCollection,
        where('Family Name', '==', family.name),
        where('Status', '==', 'completed')
      );

      const schedulesSnapshot = await getDocs(completedSchedulesQuery);
      console.log('Found', schedulesSnapshot.size, 'completed schedules');

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

      console.log('Found', existingScheduleIds.size, 'existing notification logs');

      const dismissedSchedules = this.loadDismissedPickupScheduleIds();
      let createdCount = 0;
      for (const scheduleDoc of schedulesSnapshot.docs) {
        const scheduleId = scheduleDoc.id;
        const scheduleData = scheduleDoc.data();

        if (!existingScheduleIds.has(scheduleId) && !dismissedSchedules.has(scheduleId)) {
          console.log('Creating missing notification log for schedule:', scheduleId);

          const notificationData = {
            type: 'pickup_completion',
            title: `${scheduleData['Childs Name'] || 'Child'} picked up`,
            message: `${scheduleData['Childs Name'] || 'Child'} was successfully picked up by ${scheduleData['Completed By'] || 'Unknown'}`,
            childName: scheduleData['Childs Name'] || 'Unknown Child',
            completedBy: scheduleData['Completed By'] || 'Unknown',
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
        console.log(`Created ${createdCount} missing notification logs`);

        await this.loadPickupNotifications();
      } else {
        console.log('All completed schedules already have notification logs');
      }

    } catch (error) {
      console.error('Error creating missing notification logs:', error);
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

      
      console.log('Querying pickup notifications for family:', family.name);
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const q = query(
        notificationsCollection,
        where('type', '==', 'pickup_completion'),
        where('familyName', '==', family.name)
      );

      const querySnapshot = await getDocs(q);
      console.log('Found', querySnapshot.size, 'pickup notifications');
      const allNotifications: PickupNotification[] = [];
      const dismissedSchedules = this.loadDismissedPickupScheduleIds();
      const dismissedDocIds = this.loadDismissedPickupDocIds();

      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data() as any;
        console.log('Processing notification:', docSnap.id, data);

        if (dismissedDocIds.has(docSnap.id)) {
          return;
        }
        const sid = data['scheduleId'] != null ? String(data['scheduleId']).trim() : '';
        if (sid && dismissedSchedules.has(sid)) {
          return;
        }

        const scheduleTime = data['scheduleTime'] || '';
        const scheduleTimeLabel = this.formatStoredClockTo12h(scheduleTime);

        const completedBy = data['fetcherName'] || data['completedBy'] || 'Unknown';

        const notification: PickupNotification = {
          id: docSnap.id,
          time: this.formatTime(data['createdAt']),
          title: `${data['childName'] || 'Child'} picked up`,
          subtitle: scheduleTime ? `by ${completedBy} at ${scheduleTimeLabel}` : `by ${completedBy}`,
          childName: data['childName'] || 'Unknown Child',
          fetcherName: data['fetcherName'] || 'Unknown Fetcher',
          completedBy: completedBy,
          scheduleTime: scheduleTime,
          scheduleId: sid || undefined,
          createdAt: data['createdAt'],
          type: data['type'],
          message: typeof data['message'] === 'string' ? data['message'] : undefined,
          source: 'notification',
        };
        console.log('Created notification object:', notification);
        allNotifications.push(notification);
      });

      const scanItems = await this.loadScanEventNotifications(family.name);
      allNotifications.push(...scanItems);

      const merged = this.hidePickupCompletionDuplicatedByExitScan(allNotifications);

      merged.sort((a, b) => {
        const dateA = this.notificationSortTime(a);
        const dateB = this.notificationSortTime(b);
        return dateB - dateA;
      });

      this.categorizeNotifications(merged);

    } catch (error) {
      console.error('Error loading pickup notifications:', error);
    } finally {
      if (!silent) {
        this.isLoading = false;
      }
    }
  }

  private notificationSortTime(n: PickupNotification): number {
    try {
      const d = n.createdAt?.toDate ? n.createdAt.toDate() : new Date(n.createdAt);
      const t = d.getTime();
      return Number.isNaN(t) ? 0 : t;
    } catch {
      return 0;
    }
  }

  /** Drop Firestore `pickup_completion` rows when an exit scan already describes the same pickup (same day, fetcher, child). */
  private hidePickupCompletionDuplicatedByExitScan(items: PickupNotification[]): PickupNotification[] {
    const exitScans = items.filter((n) => n.source === 'scan_event' && n.scanAction === 'Exited');
    return items.filter((n) => {
      if (n.source !== 'notification' || n.type !== 'pickup_completion') {
        return true;
      }
      const redundant = exitScans.some((e) => this.pickupCompletionMatchesExitScan(n, e));
      return !redundant;
    });
  }

  private pickupCompletionMatchesExitScan(p: PickupNotification, e: PickupNotification): boolean {
    const dayP = this.toLocalYmd(p.createdAt);
    const dayE = this.toLocalYmd(e.createdAt);
    if (!dayP || !dayE || dayP !== dayE) {
      return false;
    }
    const fetcherP = (p.completedBy || p.fetcherName || '').trim().toLowerCase();
    const fetcherE = (e.fetcherName || e.completedBy || '').trim().toLowerCase();
    if (!fetcherP || !fetcherE || fetcherP !== fetcherE) {
      return false;
    }
    const childP = (p.childName || '').trim().toLowerCase();
    if (!childP) {
      return true;
    }
    const childE = (e.childName || '').trim().toLowerCase();
    if (!childE || childE === '—') {
      return true;
    }
    const names = childE.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return names.includes(childP) || childE === childP;
  }

  private scanTimeMs(scannedAt: any): number {
    if (!scannedAt) return 0;
    if (typeof scannedAt.toMillis === 'function') return scannedAt.toMillis();
    if (typeof scannedAt.toDate === 'function') return scannedAt.toDate().getTime();
    const d = new Date(scannedAt as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
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

  private toLocalYmd(timestamp: any): string {
    if (!timestamp) return '';
    try {
      const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      if (Number.isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    } catch {
      return '';
    }
  }

  /** Schedules `Date` may be YYYY-MM-DD, Timestamp, or unpadded parts — match exit scan day reliably. */
  private scheduleDateYmdFromFirestore(val: any): string {
    if (val == null) return '';
    if (typeof val === 'string') {
      const parts = val.split('-').map((n) => parseInt(n, 10));
      if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
        const [y, mo, d] = parts;
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      const d = new Date(val);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      return '';
    }
    if (typeof val.toDate === 'function') {
      const d = val.toDate();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return '';
  }

  private displayNameFromScan(data: {
    authorizerName?: string | null;
    authorizerEmail?: string | null;
    authorizerUid?: string | null;
  }): string {
    const name = String(data.authorizerName || '').trim();
    if (name) return name;
    const email = String(data.authorizerEmail || '').trim();
    if (email) return email;
    const uid = String(data.authorizerUid || '').trim();
    if (uid) return uid;
    return 'Pickup person';
  }

  /**
   * Child names for an exit scan: same calendar day as the scan and same fetcher UID as Schedules.
   * Prefer pending rows; if none (e.g. pickup was just marked completed by exit-scan sync), use completed
   * so the exit-scan card still shows who was picked up instead of a false "no matching" warning.
   */
  private async resolveScheduledChildNamesForExit(
    familyName: string,
    authorizerUid: string,
    scannedAt: any
  ): Promise<string[]> {
    const scanYmd = this.toLocalYmd(scannedAt);
    if (!scanYmd || !familyName || !authorizerUid) {
      return [];
    }
    const schedulesCollection = collection(this.firestore, 'Schedules');
    const snap = await getDocs(
      query(schedulesCollection, where('Family Name', '==', familyName))
    );
    const pendingNames: string[] = [];
    const completedNames: string[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const docYmd = this.scheduleDateYmdFromFirestore(d['Date']);
      if (docYmd !== scanYmd) return;
      if (String(d['Fetcher UID'] || '').trim() !== authorizerUid) return;
      const child = String(d['Childs Name'] || '').trim();
      if (!child) return;
      const status = (d['Status'] as string) || 'pending';
      if (status === 'pending') {
        pendingNames.push(child);
      } else if (status === 'completed') {
        completedNames.push(child);
      }
    });
    const pick = pendingNames.length > 0 ? pendingNames : completedNames;
    return [...new Set(pick)].sort((a, b) => a.localeCompare(b));
  }

  private async loadScanEventNotifications(familyName: string): Promise<PickupNotification[]> {
    const dismissed = this.loadDismissedScanIds();
    try {
      const eventsCol = collection(this.firestore, 'ScanEvents');
      const snap = await getDocs(query(eventsCol, where('familyName', '==', familyName)));

      type RawScan = {
        docId: string;
        action: 'Entered' | 'Exited';
        authorizerUid: string;
        who: string;
        scannedAt: any;
      };

      const raws: RawScan[] = [];
      for (const docSnap of snap.docs) {
        if (dismissed.has(docSnap.id)) continue;
        const data = docSnap.data() as {
          action?: string;
          authorizerName?: string | null;
          authorizerEmail?: string | null;
          authorizerUid?: string | null;
          scannedAt?: any;
        };
        const action = data.action === 'Exited' ? 'Exited' : data.action === 'Entered' ? 'Entered' : null;
        if (!action) continue;
        raws.push({
          docId: docSnap.id,
          action,
          authorizerUid: String(data.authorizerUid || '').trim(),
          who: this.displayNameFromScan(data),
          scannedAt: data.scannedAt,
        });
      }
      raws.sort((a, b) => this.scanTimeMs(a.scannedAt) - this.scanTimeMs(b.scannedAt));

      const out: PickupNotification[] = [];

      for (const row of raws) {
        const { docId, action, authorizerUid, who, scannedAt } = row;
        let title: string;
        let subtitle: string;
        let childName = '';

        const arrivalTimeLabel = this.formatTime(scannedAt);

        if (action === 'Entered') {
          title = `${who} has arrived`;
          subtitle = `Arrived at ${arrivalTimeLabel} at the school`;
        } else {
          const children = await this.resolveScheduledChildNamesForExit(
            familyName,
            authorizerUid,
            scannedAt
          );
          childName = children.join(', ');
          const exitTimeLabel = this.formatTime(scannedAt);
          const exitSubtitle = `Exited at ${exitTimeLabel} at the school`;

          if (children.length === 1) {
            title = `${who} has picked up ${children[0]}`;
            subtitle = exitSubtitle;
          } else if (children.length > 1) {
            title = `${who} has picked up ${children.join(', ')}`;
            subtitle = exitSubtitle;
          } else {
            title = `${who} has left the school`;
            subtitle = `${exitSubtitle}. No matching pickup was found for this person today — confirm the schedule date and fetcher.`;
          }
        }

        out.push({
          id: `scan_${docId}`,
          time: this.formatTime(scannedAt),
          title,
          subtitle,
          childName: childName || '—',
          fetcherName: who,
          completedBy: who,
          createdAt: scannedAt || new Date(0),
          type: 'building_scan',
          source: 'scan_event',
          scanAction: action,
          scanEventDocId: docId,
          message:
            action === 'Entered'
              ? `${who} arrived at the school at ${arrivalTimeLabel}.`
              : childName && childName !== '—'
                ? `${who} picked up ${childName} at the school.`
                : `${who} exited the school.`,
        });
      }

      return out;
    } catch (e) {
      console.warn('ScanEvents not available or query failed (admin app writes here):', e);
      return [];
    }
  }

  categorizeNotifications(notifications: PickupNotification[]) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    this.todayNotifications = [];
    this.yesterdayNotifications = [];
    this.olderNotifications = [];

    notifications.forEach(notification => {
      const notificationDate = notification.createdAt?.toDate ?
        notification.createdAt.toDate() : new Date(notification.createdAt);

      if (this.isSameDay(notificationDate, today)) {
        this.todayNotifications.push(notification);
      } else if (this.isSameDay(notificationDate, yesterday)) {
        this.yesterdayNotifications.push(notification);
      } else {
        notification.date = notificationDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        this.olderNotifications.push(notification);
      }
    });
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
          console.warn('Pickup log delete failed (rules/offline); row stays hidden locally:', delErr);
        }
      }

      this.todayNotifications = this.todayNotifications.filter((n) => n.id !== notificationId);
      this.yesterdayNotifications = this.yesterdayNotifications.filter((n) => n.id !== notificationId);
      this.olderNotifications = this.olderNotifications.filter((n) => n.id !== notificationId);

      await this.showToast('Notification dismissed');
    } catch (error) {
      console.error('Error dismissing notification:', error);
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
