import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, query, where, getDocs, doc, deleteDoc, addDoc } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { LoadingController, ToastController } from '@ionic/angular';

const DISMISSED_SCAN_IDS_KEY = 'fetchsafe-notification-log-dismissed-scan-ids';

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
export class NotificationLogPage implements OnInit {
  todayNotifications: PickupNotification[] = [];
  yesterdayNotifications: PickupNotification[] = [];
  olderNotifications: PickupNotification[] = [];
  isLoading: boolean = false;

  detailModalOpen = false;
  detailNotification: PickupNotification | null = null;
  detailBody = '';

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

  async createMissingNotificationLogs() {
    try {
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      console.log('🔍 Checking for completed schedules without notification logs...');

      // Get all completed schedules for this family
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const completedSchedulesQuery = query(
        schedulesCollection,
        where('Family Name', '==', family.name),
        where('Status', '==', 'completed')
      );

      const schedulesSnapshot = await getDocs(completedSchedulesQuery);
      console.log('📊 Found', schedulesSnapshot.size, 'completed schedules');

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

      console.log('📋 Found', existingScheduleIds.size, 'existing notification logs');

      
      let createdCount = 0;
      for (const scheduleDoc of schedulesSnapshot.docs) {
        const scheduleId = scheduleDoc.id;
        const scheduleData = scheduleDoc.data();

        if (!existingScheduleIds.has(scheduleId)) {
          console.log('📝 Creating missing notification log for schedule:', scheduleId);

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
        console.log(`✅ Created ${createdCount} missing notification logs`);

        await this.loadPickupNotifications();
      } else {
        console.log('✅ All completed schedules already have notification logs');
      }

    } catch (error) {
      console.error('❌ Error creating missing notification logs:', error);
    }
  }



  async loadPickupNotifications() {
    try {
      this.isLoading = true;
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        return;
      }

      
      const family = await this.familyService.getUserFamily();
      if (!family) {
        return;
      }

      
      console.log('🔍 Querying pickup notifications for family:', family.name);
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const q = query(
        notificationsCollection,
        where('type', '==', 'pickup_completion'),
        where('familyName', '==', family.name)
      );

      const querySnapshot = await getDocs(q);
      console.log('📊 Found', querySnapshot.size, 'pickup notifications');
      const allNotifications: PickupNotification[] = [];

      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data() as any;
        console.log('📄 Processing notification:', docSnap.id, data);

        const scheduleTime = data['scheduleTime'] || '';
        
        const completedBy = data['fetcherName'] || data['completedBy'] || 'Unknown';

        const notification: PickupNotification = {
          id: docSnap.id,
          time: this.formatTime(data['createdAt']),
          title: `${data['childName'] || 'Child'} picked up`,
          subtitle: scheduleTime ? `by ${completedBy} at ${scheduleTime}` : `by ${completedBy}`,
          childName: data['childName'] || 'Unknown Child',
          fetcherName: data['fetcherName'] || 'Unknown Fetcher',
          completedBy: completedBy,
          scheduleTime: scheduleTime,
          createdAt: data['createdAt'],
          type: data['type'],
          message: typeof data['message'] === 'string' ? data['message'] : undefined,
          source: 'notification',
        };
        console.log('✅ Created notification object:', notification);
        allNotifications.push(notification);
      });

      const scanItems = await this.loadScanEventNotifications(family.name);
      allNotifications.push(...scanItems);

      allNotifications.sort((a, b) => {
        const dateA = this.notificationSortTime(a);
        const dateB = this.notificationSortTime(b);
        return dateB - dateA;
      });

      
      this.categorizeNotifications(allNotifications);

    } catch (error) {
      console.error('Error loading pickup notifications:', error);
    } finally {
      this.isLoading = false;
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
   * Pending schedules for this family + calendar day + fetcher (set when admin assigns pickup in Schedules).
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
    const names: string[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (String(d['Date'] || '') !== scanYmd) return;
      const status = d['Status'] || 'pending';
      if (status !== 'pending') return;
      if (String(d['Fetcher UID'] || '') !== authorizerUid) return;
      const child = String(d['Childs Name'] || '').trim();
      if (child) names.push(child);
    });
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  private async loadScanEventNotifications(familyName: string): Promise<PickupNotification[]> {
    const dismissed = this.loadDismissedScanIds();
    try {
      const eventsCol = collection(this.firestore, 'ScanEvents');
      const snap = await getDocs(query(eventsCol, where('familyName', '==', familyName)));
      const out: PickupNotification[] = [];

      for (const docSnap of snap.docs) {
        if (dismissed.has(docSnap.id)) continue;
        const data = docSnap.data() as {
          action?: string;
          authorizerName?: string | null;
          authorizerEmail?: string | null;
          authorizerUid?: string | null;
          scannedAt?: any;
          familyName?: string;
        };
        const action = data.action === 'Exited' ? 'Exited' : data.action === 'Entered' ? 'Entered' : null;
        if (!action) continue;

        const who = this.displayNameFromScan(data);
        const scannedAt = data.scannedAt;
        let title: string;
        let subtitle: string;
        let childName = '';

        if (action === 'Entered') {
          title = `${who} has arrived`;
          subtitle = 'Checked in at the building';
        } else {
          const children = await this.resolveScheduledChildNamesForExit(
            familyName,
            String(data.authorizerUid || '').trim(),
            scannedAt
          );
          childName = children.join(', ');
          if (children.length === 1) {
            title = `${who} has picked up ${children[0]}`;
            subtitle = 'Checked out at the building';
          } else if (children.length > 1) {
            title = `${who} has picked up ${children.join(', ')}`;
            subtitle = 'Checked out at the building';
          } else {
            title = `${who} has left the building`;
            subtitle =
              'No matching pending pickup was found for this person today — confirm the schedule date and fetcher.';
          }
        }

        out.push({
          id: `scan_${docSnap.id}`,
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
          scanEventDocId: docSnap.id,
          message:
            action === 'Entered'
              ? `${who} arrived at the building.`
              : childName
                ? `${who} picked up ${childName}.`
                : `${who} exited the building.`,
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

  async dismissNotification(notificationId: string) {
    try {
      if (notificationId.startsWith('scan_')) {
        const scanDocId = notificationId.replace(/^scan_/, '');
        const dismissed = this.loadDismissedScanIds();
        dismissed.add(scanDocId);
        this.saveDismissedScanIds(dismissed);
      } else {
        const notificationDoc = doc(this.firestore, 'Notifications', notificationId);
        await deleteDoc(notificationDoc);
      }

      this.todayNotifications = this.todayNotifications.filter(n => n.id !== notificationId);
      this.yesterdayNotifications = this.yesterdayNotifications.filter(n => n.id !== notificationId);
      this.olderNotifications = this.olderNotifications.filter(n => n.id !== notificationId);

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
        n.scanAction === 'Entered' ? 'Building check-in' : 'Building check-out',
        n.title,
        n.subtitle,
        `Time: ${this.detailTimestamp(n)}`,
      ].filter(Boolean);
      return lines.join('\n\n');
    }
    const lines = [
      `Child: ${n.childName || ''}`.trim(),
      `Picked up by: ${n.completedBy || ''}`.trim(),
      n.scheduleTime ? `Scheduled time: ${n.scheduleTime}` : '',
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
