import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Firestore, collection, getDocs } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { JoinRequestService, JoinRequest } from '../services/join-request.service';
import { FamilyService } from '../services/family.service';
import { PasswordChangeService } from '../services/password-change.service';
import { NotificationEmailForwardService } from '../services/notification-email-forward.service';
import { AlertController, ToastController, LoadingController, ModalController } from '@ionic/angular';

interface Notification {
  id: string;
  type:
    | 'schedule'
    | 'request'
    | 'success'
    | 'join_request'
    | 'join_approved'
    | 'join_denied'
    | 'schedule_completion'
    | 'schedule_assignment'
    | 'pickup_completion'
    | 'panic_alert'
    | 'password_change_required'
    | 'admin_announcement';
  title: string;
  message: string;
  time: string;
  sortTime: number;
  isRead: boolean;
  joinRequestId?: string;
  joinRequestStatus?: 'pending' | 'approved' | 'denied';
  joinRequestRole?: 'parent' | 'companion';
  senderId?: string;
  senderName?: string;
  familyName?: string;
  passwordChanged?: boolean;
}

@Component({
  selector: 'app-notifications',
  templateUrl: './notifications.page.html',
  styleUrls: ['./notifications.page.scss'],
  standalone: false
})
export class NotificationsPage implements OnInit {
  /** Firestore collection for school-wide admin posts (console may show plural "Announcements") */
  private static readonly ANNOUNCEMENTS_COLLECTION = 'Announcements';

  private static readonly WEEKDAY_ORDER: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };

  notifications: Notification[] = [];
  isLoading: boolean = false;
  detailModalOpen = false;
  detailNotification: Notification | null = null;

  constructor(
    private location: Location,
    private firestore: Firestore,
    private authService: AuthService,
    private joinRequestService: JoinRequestService,
    private familyService: FamilyService,
    private passwordChangeService: PasswordChangeService,
    private notificationEmailForwardService: NotificationEmailForwardService,
    private alertController: AlertController,
    private toastController: ToastController,
    private loadingController: LoadingController,
    private modalController: ModalController
  ) { }

  async ngOnInit() {
    await this.loadNotifications();
  }

  async loadNotifications() {
    try {
      this.isLoading = true;
      const currentUser = this.authService.getCurrentUser();

      const [announcementItems, userItems] = await Promise.all([
        this.fetchAnnouncements(),
        currentUser ? this.loadUserNotificationItems(currentUser.uid) : Promise.resolve([]),
      ]);

      this.notifications = [...announcementItems, ...userItems].sort(
        (a, b) => b.sortTime - a.sortTime
      );

      if (currentUser?.email && this.notificationEmailForwardService.isEmailForwardingEnabled()) {
        await this.notificationEmailForwardService.forwardNewNotifications(
          this.notifications.map((n) => ({
            id: n.id,
            title: n.title,
            displayMessage: this.formatNotificationDisplayMessage(n),
            time: n.time,
          })),
          currentUser.email
        );
      }
    } catch (error) {
      console.error('Error loading notifications:', error);
    } finally {
      this.isLoading = false;
    }
  }

  private async fetchAnnouncements(): Promise<Notification[]> {
    try {
      const col = collection(this.firestore, NotificationsPage.ANNOUNCEMENTS_COLLECTION);
      const snap = await getDocs(col);
      const items: Notification[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as {
          title?: string;
          body?: string;
          createdAt?: unknown;
        };
        const body = typeof data.body === 'string' ? data.body : '';
        const title = (typeof data.title === 'string' && data.title.trim()) ? data.title.trim() : 'Announcement';
        items.push({
          id: docSnap.id,
          type: 'admin_announcement',
          title,
          message: body,
          time: this.formatTime(data.createdAt),
          sortTime: this.getTimestampMs(data.createdAt),
          isRead: true,
        });
      });
      return items;
    } catch (e) {
      console.error('Error loading announcements:', e);
      return [];
    }
  }

  private async loadUserNotificationItems(uid: string): Promise<Notification[]> {
    const realNotifications = await this.joinRequestService.getUserNotifications(uid);
    return Promise.all(
      realNotifications.map(async (notification) => {
        let joinRequestStatus: 'pending' | 'approved' | 'denied' | undefined;
        let joinRequestRole: 'parent' | 'companion' | undefined;

        if (notification.type === 'join_request' && notification.joinRequestId) {
          const jr = await this.joinRequestService.getJoinRequestById(notification.joinRequestId);
          if (jr) {
            joinRequestStatus = jr.status;
            joinRequestRole = jr.role;
          }
        }

        return {
          id: notification.id || '',
          type: notification.type,
          title: notification.title,
          message:
            notification.type === 'panic_alert' && notification.senderName
              ? `Emergency alert triggered by ${notification.senderName}`
              : notification.message,
          time: this.formatTime(notification.createdAt),
          sortTime: this.getTimestampMs(notification.createdAt),
          isRead: notification.isRead,
          joinRequestId: notification.joinRequestId,
          joinRequestStatus,
          joinRequestRole,
          senderId: notification.senderId,
          senderName: notification.senderName,
          familyName: notification.familyName,
          passwordChanged: (notification as any).passwordChanged === true,
        } as Notification;
      })
    );
  }

  formatTime(timestamp: any): string {
    if (!timestamp) return 'Unknown';

    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      const timeOfDay = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      if (diffDays === 0) {
        return `Today, ${timeOfDay}`;
      } else if (diffDays === 1) {
        return `Yesterday, ${timeOfDay}`;
      } else if (diffDays < 7) {
        return `${diffDays} days ago, ${timeOfDay}`;
      } else {
        return `${date.toLocaleDateString()}, ${timeOfDay}`;
      }
    } catch (error) {
      return 'Unknown';
    }
  }

  private getTimestampMs(timestamp: any): number {
    try {
      const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
      const ms = date?.getTime?.();
      return typeof ms === 'number' && !Number.isNaN(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }

  async onNotificationClick(notification: Notification, event?: Event) {
    event?.stopPropagation();

    if (
      notification.type !== 'admin_announcement' &&
      !notification.isRead &&
      notification.id
    ) {
      await this.joinRequestService.markNotificationAsRead(notification.id);
      notification.isRead = true;
    }

    this.detailNotification = notification;
    this.detailModalOpen = true;
  }

  closeDetailModal(): void {
    this.detailModalOpen = false;
    this.detailNotification = null;
  }

  detailRespondJoin(): void {
    const n = this.detailNotification;
    if (!n?.joinRequestId) return;
    this.closeDetailModal();
    setTimeout(() => void this.handleJoinRequestNotification(n), 200);
  }

  detailChangePassword(): void {
    const n = this.detailNotification;
    if (!n) return;
    this.closeDetailModal();
    setTimeout(() => void this.handlePasswordChangeNotification(n), 200);
  }

  async handleJoinRequestNotification(notification: Notification) {
    if (!notification.joinRequestId) return;

    
    const joinRequest = await this.joinRequestService.getJoinRequestById(notification.joinRequestId);

    if (!joinRequest) {
      this.showToast('Join request not found');
      return;
    }

    if (joinRequest.status !== 'pending') {
      this.showToast(`This request has already been ${joinRequest.status}`);
      return;
    }

    
    const alert = await this.alertController.create({
      header: 'Approve Join Request',
      message: `${joinRequest.requesterName} wants to join your family "${joinRequest.familyName}". Select their role:`,
      inputs: [
        {
          name: 'companion',
          type: 'radio',
          label: 'Companion (Limited Access)',
          value: 'companion',
          checked: true
        },
        {
          name: 'parent',
          type: 'radio',
          label: 'Parent (Full Access)',
          value: 'parent',
          checked: false
        }
      ],
      buttons: [
        {
          text: 'Deny',
          role: 'destructive',
          handler: async () => {
            await this.denyJoinRequest(joinRequest);
          }
        },
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Approve',
          handler: async (selectedRole) => {
            await this.approveJoinRequest(joinRequest, selectedRole);
          }
        }
      ]
    });

    await alert.present();
  }

  async approveJoinRequest(joinRequest: JoinRequest, role: 'parent' | 'companion' = 'companion') {
    try {
      const loading = await this.loadingController.create({
        message: 'Approving request...'
      });
      await loading.present();

      
      if (joinRequest.id) {
        const result = await this.joinRequestService.approveJoinRequest(joinRequest.id, role);

        if (result.success) {
          await this.familyService.addUserToFamilyWithData(joinRequest, joinRequest.familyName, role);

          
          await this.joinRequestService.createNotification({
            type: 'join_approved',
            title: 'Request Approved',
            message: `Your request to join "${joinRequest.familyName}" has been approved! Your role is: ${role}`,
            recipientId: joinRequest.requesterId,
            senderId: joinRequest.familyOwnerId,
            senderName: 'Family Owner',
            familyName: joinRequest.familyName,
            isRead: false,
            createdAt: new Date()
          });

          this.showToast(`Join request approved successfully. User assigned as ${role}.`);
          await this.loadNotifications(); 
        } else {
          this.showToast(result.message);
        }
      }

      await loading.dismiss();
    } catch (error) {
      console.error('Error approving join request:', error);
      this.showToast('Error approving request. Please try again.');
    }
  }

  async denyJoinRequest(joinRequest: JoinRequest) {
    try {
      const loading = await this.loadingController.create({
        message: 'Denying request...'
      });
      await loading.present();

      if (joinRequest.id) {
        const result = await this.joinRequestService.denyJoinRequest(joinRequest.id);

        if (result.success) {
          
          await this.joinRequestService.createNotification({
            type: 'join_denied',
            title: 'Request Denied',
            message: `Your request to join "${joinRequest.familyName}" has been denied.`,
            recipientId: joinRequest.requesterId,
            senderId: joinRequest.familyOwnerId,
            senderName: 'Family Owner',
            familyName: joinRequest.familyName,
            isRead: false,
            createdAt: new Date()
          });

          this.showToast('Join request denied');
          await this.loadNotifications(); 
        } else {
          this.showToast(result.message);
        }
      }

      await loading.dismiss();
    } catch (error) {
      console.error('Error denying join request:', error);
      this.showToast('Error denying request. Please try again.');
    }
  }

  async handlePasswordChangeNotification(notification: Notification) {
    try {
      // Dynamically import the modal component
      const { PasswordChangeModalComponent } = await import('./password-change-modal/password-change-modal.component');

      const currentUser = this.authService.getCurrentUser();
      const passwordAlreadyChanged = currentUser?.['passwordChanged'] === true || notification.passwordChanged === true;

      const modal = await this.modalController.create({
        component: PasswordChangeModalComponent,
        componentProps: {
          notificationId: notification.id,
          passwordAlreadyChanged: passwordAlreadyChanged
        },
        cssClass: 'password-change-modal-class',
        backdropDismiss: false
      });

      await modal.present();

      const { data } = await modal.onDidDismiss();
      if (data?.success) {
        await this.loadNotifications();
        this.showToast('Password changed successfully!');
      }
    } catch (error) {
      console.error('Error handling password change notification:', error);
      this.showToast('Error opening password change dialog');
    }
  }

  /** Human-readable message for schedule-related notifications (dates + times in body text) */
  formatNotificationDisplayMessage(n: Notification): string {
    const scheduleTypes: Notification['type'][] = [
      'schedule_assignment',
      'schedule_completion',
      'pickup_completion',
      'schedule',
    ];
    if (!scheduleTypes.includes(n.type)) {
      return n.message;
    }
    return this.beautifyScheduleNotificationText(n.message);
  }

  private beautifyScheduleNotificationText(text: string): string {
    if (!text) {
      return text;
    }
    let out = text;
    out = out.replace(/pick up \d+ (?:child|children) \(([^)]+)\)/gi, 'pick up $1');
    out = this.sortWeekdayPhraseInMessage(out);
    out = out.replace(/Dates:\s*((?:\d{4}-\d{2}-\d{2})(?:\s*,\s*\d{4}-\d{2}-\d{2})*)/gi, (_, datesPart: string) => {
      return `Dates: ${this.formatIsoDatesListWithRanges(datesPart)}`;
    });
    out = out.replace(/\bat\s+(\d{1,2}):(\d{2})(?::\d{2})?\b/gi, (_m, h: string, min: string) => {
      const hour24 = Math.min(23, Math.max(0, parseInt(h, 10)));
      return `at ${this.format24hTo12h(hour24, min)}`;
    });
    out = out.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) =>
      this.formatYmdUs(`${y}-${mo}-${d}`)
    );
    return out;
  }

  /** Fix legacy messages where weekdays were sorted alphabetically (Fri before Mon) */
  private sortWeekdayPhraseInMessage(text: string): string {
    const dayNames =
      'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
    const re = new RegExp(
      `\\bon\\s+((?:${dayNames})(?:\\s*,\\s*(?:${dayNames}))*)\\s+at\\b`,
      'gi'
    );
    return text.replace(re, (_m, daysPart: string) => {
      const days = daysPart.split(',').map((s) => s.trim()).filter(Boolean);
      const uniq = [...new Set(days)];
      const sorted = uniq.sort(
        (a, b) =>
          (NotificationsPage.WEEKDAY_ORDER[a] ?? 99) -
          (NotificationsPage.WEEKDAY_ORDER[b] ?? 99)
      );
      return `on ${this.formatWeekdayList(sorted)} at`;
    });
  }

  /** Collapse consecutive weekdays: Mon,Tue,Wed -> "Monday - Wednesday" */
  private formatWeekdayList(sorted: string[]): string {
    if (sorted.length === 0) {
      return '';
    }
    if (sorted.length === 1) {
      return sorted[0];
    }
    const orders = sorted.map((d) => NotificationsPage.WEEKDAY_ORDER[d] ?? -1);
    let consecutive = true;
    for (let i = 1; i < sorted.length; i++) {
      if (orders[i] !== orders[i - 1] + 1) {
        consecutive = false;
        break;
      }
    }
    if (consecutive) {
      return `${sorted[0]} - ${sorted[sorted.length - 1]}`;
    }
    return sorted.join(', ');
  }

  /** Parse ISO date as local calendar day (no time / TZ shift). */
  private parseYmdLocal(ymd: string): Date | null {
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return null;
    }
    const [y, m, day] = parts;
    const d = new Date(y, m - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) {
      return null;
    }
    return d;
  }

  private calendarDaysBetween(a: Date, b: Date): number {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / (24 * 60 * 60 * 1000));
  }

  private groupConsecutiveCalendarDays(sorted: Date[]): Date[][] {
    const groups: Date[][] = [];
    let current: Date[] = [];
    for (const d of sorted) {
      if (current.length === 0) {
        current = [d];
        continue;
      }
      const prev = current[current.length - 1];
      if (this.calendarDaysBetween(prev, d) === 1) {
        current.push(d);
      } else {
        groups.push(current);
        current = [d];
      }
    }
    if (current.length) {
      groups.push(current);
    }
    return groups;
  }

  private formatDateUsFromDate(d: Date): string {
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  /** e.g. May 4-9, 2026 or Apr 30 - May 2, 2026 */
  private formatDateRangeCompact(start: Date, end: Date): string {
    if (this.calendarDaysBetween(start, end) === 0) {
      return this.formatDateUsFromDate(start);
    }
    const y0 = start.getFullYear();
    const y1 = end.getFullYear();
    const m0 = start.getMonth();
    const m1 = end.getMonth();
    const d0 = start.getDate();
    const d1 = end.getDate();

    if (y0 === y1 && m0 === m1) {
      const monthStr = start.toLocaleDateString('en-US', { month: 'short' });
      return `${monthStr} ${d0}-${d1}, ${y0}`;
    }
    if (y0 === y1) {
      const sm = start.toLocaleDateString('en-US', { month: 'short' });
      const em = end.toLocaleDateString('en-US', { month: 'short' });
      return `${sm} ${d0} - ${em} ${d1}, ${y0}`;
    }
    return `${this.formatDateUsFromDate(start)} - ${this.formatDateUsFromDate(end)}`;
  }

  private formatIsoDatesListWithRanges(datesPart: string): string {
    const dateStrs = datesPart.split(',').map((s) => s.trim()).filter(Boolean);
    const parsed: Date[] = [];
    for (const s of dateStrs) {
      const d = this.parseYmdLocal(s);
      if (d) {
        parsed.push(d);
      }
    }
    if (parsed.length === 0) {
      return dateStrs.map((s) => this.formatYmdUs(s)).join(', ');
    }
    const byDay = new Map<string, Date>();
    for (const d of parsed) {
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      byDay.set(key, d);
    }
    const sorted = [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
    const groups = this.groupConsecutiveCalendarDays(sorted);
    return groups.map((g) => this.formatDateRangeCompact(g[0], g[g.length - 1])).join(', ');
  }

  private formatYmdUs(ymd: string): string {
    const d = this.parseYmdLocal(ymd);
    if (!d) {
      return ymd;
    }
    return this.formatDateUsFromDate(d);
  }

  private format24hTo12h(hour24: number, minuteStr: string): string {
    const min = minuteStr.padStart(2, '0');
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    const h12 = hour24 % 12 || 12;
    return `${h12}:${min} ${ampm}`;
  }

  getNotificationIcon(type: string): string {
    switch (type) {
      case 'admin_announcement':
        return 'megaphone-outline';
      case 'schedule':
      case 'schedule_assignment':
        return 'calendar-outline';
      case 'schedule_completion':
        return 'checkmark-done-outline';
      case 'pickup_completion':
        return 'checkmark-circle-outline';
      case 'panic_alert':
        return 'warning-outline';
      case 'request':
      case 'join_request':
        return 'person-add-outline';
      case 'success':
      case 'join_approved':
        return 'checkmark-circle-outline';
      case 'join_denied':
        return 'close-circle-outline';
      case 'password_change_required':
        return 'lock-outline';
      default:
        return 'notifications-outline';
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      position: 'bottom'
    });
    await toast.present();
  }

  goBack() {
    this.location.back();
  }
}
