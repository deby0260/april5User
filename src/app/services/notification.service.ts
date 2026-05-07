import { Injectable } from '@angular/core';
import { Platform } from '@ionic/angular';
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from '@capacitor/push-notifications';
import { LocalNotifications, LocalNotificationSchema } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth';
import {
  Firestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  deleteField,
} from '@angular/fire/firestore';
import { environment } from '../../environments/environment';

export interface NotificationData {
  id?: string;
  title: string;
  body: string;
  type: 'panic' | 'family_update' | 'schedule' | 'general';
  familyName?: string;
  senderName?: string;
  timestamp: Date;
  read: boolean;
  actionUrl?: string;
}

type PickupReminderExtra = {
  kind: 'pickup_reminder_30m';
  /** Unique id for idempotent writes / schedules (e.g. scheduleId + reminderAt). */
  reminderKey: string;
  scheduleId?: string;
  scheduleDate?: string;
  scheduleTime?: string;
  familyName?: string;
  childName?: string;
};

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private isInitialized = false;
  /** Push + local listeners attached (reset when user turns off app notifications). */
  private nativeStackAttached = false;

  private static readonly SETTINGS_STORAGE_KEY = 'fetchsafe-settings';
  private static readonly PICKUP_REMINDER_KEYS_STORAGE = 'fetchsafe-pickup-reminder-keys-v1';

  constructor(
    private platform: Platform,
    private authService: AuthService,
    private firestore: Firestore
  ) {}

  /**
   * Reads the Settings toggle (localStorage). Default true if unset so existing users keep behavior.
   */
  readAppNotificationsEnabled(): boolean {
    try {
      const raw = localStorage.getItem(NotificationService.SETTINGS_STORAGE_KEY);
      if (!raw) return true;
      const parsed = JSON.parse(raw) as { appNotifications?: boolean };
      return parsed.appNotifications !== false;
    } catch {
      return true;
    }
  }

  /**
   * Apply the "Enable app notifications" setting on the device: permissions, FCM registration, listeners.
   * Call after saving settings (and when enabling) so the phone can receive local + push alerts.
   */
  async syncAppNotificationPreference(enabled: boolean): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    if (!enabled) {
      await this.cancelAllPendingLocalNotifications();
      try {
        await PushNotifications.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        await LocalNotifications.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        await PushNotifications.unregister();
      } catch {
        /* noop */
      }
      this.nativeStackAttached = false;
      this.isInitialized = false;
      await this.clearPushTokenInProfile();
      return;
    }
    await this.attachNativeNotificationStack();
    this.isInitialized = true;
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      if (!Capacitor.isNativePlatform()) {
        this.isInitialized = true;
        return;
      }
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      await this.attachNativeNotificationStack();
      this.isInitialized = true;
    } catch (error) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private async attachNativeNotificationStack(): Promise<void> {
    if (this.nativeStackAttached) {
      return;
    }
    await this.initializePushNotifications();
    await this.initializeLocalNotifications();
    this.nativeStackAttached = true;
  }

  private async cancelAllPendingLocalNotifications(): Promise<void> {
    try {
      const { notifications } = await LocalNotifications.getPending();
      if (!notifications?.length) {
        return;
      }
      await LocalNotifications.cancel({
        notifications: notifications.map((n) => ({ id: n.id })),
      });
    } catch (e) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private async clearPushTokenInProfile(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;
      const userDocRef = doc(this.firestore, 'users', currentUser.uid);
      await updateDoc(userDocRef, {
        pushToken: deleteField(),
        lastTokenUpdate: deleteField(),
      });
    } catch (e) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private async initializePushNotifications() {
    if (!environment.enableCapacitorPushRegistration) {
      return;
    }

    const permission = await PushNotifications.requestPermissions();
    
    if (permission.receive === 'granted') {
      
      await PushNotifications.register();

      
      PushNotifications.addListener('registration', async (token: Token) => {
        await this.savePushToken(token.value);
      });

      
      PushNotifications.addListener('pushNotificationReceived', (notification: PushNotificationSchema) => {
        this.handlePushNotificationReceived(notification);
      });

      
      PushNotifications.addListener('pushNotificationActionPerformed', (notification: ActionPerformed) => {
        this.handlePushNotificationAction(notification);
      });
    } else {
    }
  }

  private async initializeLocalNotifications() {
    
    const permission = await LocalNotifications.requestPermissions();
    
    if (permission.display === 'granted') {
      LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
        this.handleLocalNotificationAction(notification);
      });
      LocalNotifications.addListener('localNotificationReceived', (notification) => {
        void this.handleLocalNotificationReceived(notification);
      });
    } else {
    }
  }

  private async savePushToken(token: string) {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const userDocRef = doc(this.firestore, 'users', currentUser.uid);
      await updateDoc(userDocRef, {
        pushToken: token,
        lastTokenUpdate: new Date()
      });
    } catch (error) {
      // Intentionally silent: avoid console chatter.
    }
  }

  private handlePushNotificationReceived(notification: PushNotificationSchema) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }

    if (notification.data?.type === 'panic') {
      this.handlePanicNotification(notification);
    }
  }

  private handlePushNotificationAction(notification: ActionPerformed) {
    if (notification.notification.data?.actionUrl) {
    }
  }

  private handleLocalNotificationAction(notification: any) {
  }

  private async handleLocalNotificationReceived(notification: any): Promise<void> {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      const extra = (notification?.extra || {}) as Partial<PickupReminderExtra> & Record<string, unknown>;
      if (extra.kind !== 'pickup_reminder_30m' || !extra.reminderKey) {
        return;
      }
      await this.writePickupReminderToInAppNotifications(extra as PickupReminderExtra);
    } catch {
      // Intentionally silent.
    }
  }

  private handlePanicNotification(notification: PushNotificationSchema) {
    this.showLocalNotification({
      title: 'PANIC ALERT',
      body: notification.body || 'Emergency alert received',
      type: 'panic',
      timestamp: new Date(),
      read: false
    });
  }

  async showLocalNotification(notificationData: NotificationData) {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      if (!Capacitor.isNativePlatform()) {
        return;
      }

      const notification: LocalNotificationSchema = {
        title: notificationData.title,
        body: notificationData.body,
        id: Date.now(),
        schedule: { at: new Date(Date.now() + 1000) }, 
        sound: notificationData.type === 'panic' ? 'beep.wav' : undefined,
        attachments: undefined,
        actionTypeId: notificationData.type,
        extra: {
          type: notificationData.type,
          familyName: notificationData.familyName,
          actionUrl: notificationData.actionUrl
        }
      };

      await LocalNotifications.schedule({
        notifications: [notification]
      });
    } catch (error) {
    }
  }

  async sendPanicNotification(familyName: string, senderName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: 'PANIC ALERT',
        body: `${senderName} has triggered a panic alert in ${familyName}`,
        type: 'panic',
        familyName: familyName,
        senderName: senderName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/notifications'
      };

      
      await this.showLocalNotification(notificationData);

      
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  async sendFamilyUpdateNotification(title: string, message: string, familyName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: title,
        body: message,
        type: 'family_update',
        familyName: familyName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/created-family'
      };

      await this.showLocalNotification(notificationData);
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  async sendScheduleNotification(title: string, message: string, familyName: string) {
    if (!this.readAppNotificationsEnabled()) {
      return;
    }
    try {
      const notificationData: NotificationData = {
        title: title,
        body: message,
        type: 'schedule',
        familyName: familyName,
        timestamp: new Date(),
        read: false,
        actionUrl: '/view-schedule'
      };

      await this.showLocalNotification(notificationData);
      await this.saveNotificationToHistory(notificationData);
    } catch (error) {
    }
  }

  /**
   * Schedules a local reminder for the currently signed-in user (typically the assigned fetcher/companion)
   * and ensures the reminder shows up inside the in-app Notifications feed at delivery time.
   *
   * Dedupe:
   * - device-level: localStorage remembers scheduled reminder keys
   * - Firestore-level: reminder doc id is deterministic (reminderKey)
   */
  async schedulePickupReminder30m(input: {
    scheduleId: string;
    familyName: string;
    childName: string;
    scheduleDateYmd: string; // YYYY-MM-DD
    scheduleTime: string; // "HH:mm" or "h:mm AM/PM"
  }): Promise<void> {
    try {
      if (!this.readAppNotificationsEnabled()) {
        return;
      }
      if (!Capacitor.isNativePlatform()) {
        return;
      }
      const reminderAt = this.computeReminderAtLocal(input.scheduleDateYmd, input.scheduleTime, 30);
      if (!reminderAt) {
        return;
      }
      const now = Date.now();
      if (reminderAt.getTime() <= now + 5_000) {
        // Too late / immediate; skip rather than spamming on open.
        return;
      }

      const reminderKey = `pickupReminder30m:${input.scheduleId}:${reminderAt.toISOString()}`;
      if (this.hasScheduledPickupReminderKey(reminderKey)) {
        return;
      }

      const title = 'Pickup in 30 minutes';
      const body = `${input.childName} pickup is scheduled at ${this.formatClockTo12h(input.scheduleTime)}.`;

      const notification: LocalNotificationSchema = {
        title,
        body,
        id: this.localNotificationIdFromKey(reminderKey),
        schedule: { at: reminderAt },
        actionTypeId: 'schedule',
        extra: {
          kind: 'pickup_reminder_30m',
          reminderKey,
          scheduleId: input.scheduleId,
          scheduleDate: input.scheduleDateYmd,
          scheduleTime: input.scheduleTime,
          familyName: input.familyName,
          childName: input.childName,
        } satisfies PickupReminderExtra,
      };

      await LocalNotifications.schedule({ notifications: [notification] });
      this.rememberScheduledPickupReminderKey(reminderKey);
    } catch {
      // Intentionally silent.
    }
  }

  private localNotificationIdFromKey(key: string): number {
    // Stable 31-bit int hash for Capacitor LocalNotifications id
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 2_000_000_000;
  }

  private hasScheduledPickupReminderKey(key: string): boolean {
    try {
      const raw = localStorage.getItem(NotificationService.PICKUP_REMINDER_KEYS_STORAGE);
      if (!raw) return false;
      const arr = JSON.parse(raw) as string[];
      if (!Array.isArray(arr)) return false;
      return arr.includes(key);
    } catch {
      return false;
    }
  }

  private rememberScheduledPickupReminderKey(key: string): void {
    try {
      const raw = localStorage.getItem(NotificationService.PICKUP_REMINDER_KEYS_STORAGE);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      const next = Array.isArray(arr) ? arr : [];
      if (!next.includes(key)) {
        next.push(key);
      }
      // Keep bounded so it doesn't grow forever.
      const trimmed = next.slice(-400);
      localStorage.setItem(
        NotificationService.PICKUP_REMINDER_KEYS_STORAGE,
        JSON.stringify(trimmed)
      );
    } catch {
      // noop
    }
  }

  private computeReminderAtLocal(
    dateYmd: string,
    timeStr: string,
    minutesBefore: number
  ): Date | null {
    const dparts = String(dateYmd || '').split('-').map((n) => parseInt(n, 10));
    if (dparts.length !== 3 || dparts.some((n) => Number.isNaN(n))) {
      return null;
    }
    const [y, m, day] = dparts;
    const minutes = this.parseClockToMinutes(timeStr);
    if (minutes == null) {
      return null;
    }
    const base = new Date(y, m - 1, day, 0, 0, 0, 0);
    const at = new Date(base.getTime() + minutes * 60_000);
    at.setMinutes(at.getMinutes() - minutesBefore);
    return at;
  }

  private parseClockToMinutes(timeStr: string): number | null {
    const t = String(timeStr || '').trim();
    if (!t) return null;
    const ampm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const ap = ampm[4].toUpperCase();
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    }
    const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24) {
      const h = parseInt(h24[1], 10);
      const m = parseInt(h24[2], 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, m));
    }
    return null;
  }

  private formatClockTo12h(timeStr: string): string {
    const t = String(timeStr || '').trim();
    if (!t) return '';
    const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const h24 = parseInt(m[1], 10);
      const min = m[2];
      if (Number.isNaN(h24)) return t;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 || 12;
      return `${h12}:${min} ${ampm}`;
    }
    // Already in AM/PM
    return t;
  }

  private async writePickupReminderToInAppNotifications(extra: PickupReminderExtra): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser?.uid) return;

    const message = `30 minutes before pick up schedule: ${extra.childName || 'Child'} at ${this.formatClockTo12h(extra.scheduleTime || '')}.`;
    const ref = doc(this.firestore, 'Notifications', extra.reminderKey);
    await setDoc(
      ref,
      {
        type: 'schedule',
        title: 'Pickup Reminder',
        message,
        recipientId: currentUser.uid,
        senderId: currentUser.uid,
        senderName: currentUser.fullName || currentUser.email || 'Family Member',
        familyName: extra.familyName || '',
        scheduleDate: extra.scheduleDate || '',
        scheduleTime: extra.scheduleTime || '',
        scheduleId: extra.scheduleId || '',
        isRead: false,
        createdAt: new Date(),
      },
      { merge: true }
    );
  }

  private async saveNotificationToHistory(notificationData: NotificationData) {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const notificationRef = doc(collection(this.firestore, 'notifications'));
      await setDoc(notificationRef, {
        ...notificationData,
        userId: currentUser.uid,
        id: notificationRef.id
      });
    } catch (error) {
    }
  }

  async clearAllNotifications() {
    try {
      if (Capacitor.isNativePlatform()) {
        await this.cancelAllPendingLocalNotifications();
      }
    } catch (error) {
    }
  }

  async getPushToken(): Promise<string | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return null;

      const userDocRef = doc(this.firestore, 'users', currentUser.uid);
      const userDoc = await getDoc(userDocRef);

      if (userDoc.exists()) {
        return userDoc.data()['pushToken'] || null;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  
  async sendTestNotification() {
    try {
      const testNotification: NotificationData = {
        title: 'Test Notification',
        body: 'This is a test notification to verify the system is working correctly.',
        type: 'general',
        timestamp: new Date(),
        read: false,
        actionUrl: '/home'
      };

      await this.showLocalNotification(testNotification);
    } catch (error) {
    }
  }
}
