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

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private isInitialized = false;
  /** Push + local listeners attached (reset when user turns off app notifications). */
  private nativeStackAttached = false;

  private static readonly SETTINGS_STORAGE_KEY = 'fetchsafe-settings';

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
