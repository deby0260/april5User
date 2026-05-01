import { Injectable } from '@angular/core';
import { Platform } from '@ionic/angular';
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from '@capacitor/push-notifications';
import { LocalNotifications, LocalNotificationSchema } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth';
import { Firestore, collection, doc, setDoc, updateDoc, getDoc } from '@angular/fire/firestore';
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

  constructor(
    private platform: Platform,
    private authService: AuthService,
    private firestore: Firestore
  ) {}

  async initialize() {
    if (this.isInitialized) return;

    try {
      if (Capacitor.isNativePlatform()) {
        await this.initializePushNotifications();
        await this.initializeLocalNotifications();
      }
      this.isInitialized = true;
      console.log('✅ Notification service initialized');
    } catch (error) {
      console.error('❌ Error initializing notifications:', error);
    }
  }

  private async initializePushNotifications() {
    if (!environment.enableCapacitorPushRegistration) {
      console.warn(
        'Capacitor push (FCM) skipped: set environment.enableCapacitorPushRegistration to true after adding android/app/google-services.json'
      );
      return;
    }

    const permission = await PushNotifications.requestPermissions();
    
    if (permission.receive === 'granted') {
      
      await PushNotifications.register();

      
      PushNotifications.addListener('registration', async (token: Token) => {
        console.log('📱 Push registration token:', token.value);
        await this.savePushToken(token.value);
      });

      
      PushNotifications.addListener('pushNotificationReceived', (notification: PushNotificationSchema) => {
        console.log('📨 Push notification received:', notification);
        this.handlePushNotificationReceived(notification);
      });

      
      PushNotifications.addListener('pushNotificationActionPerformed', (notification: ActionPerformed) => {
        console.log('👆 Push notification action performed:', notification);
        this.handlePushNotificationAction(notification);
      });
    } else {
      console.warn('⚠️ Push notification permission not granted');
    }
  }

  private async initializeLocalNotifications() {
    
    const permission = await LocalNotifications.requestPermissions();
    
    if (permission.display === 'granted') {
      console.log('✅ Local notification permission granted');

      
      LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
        console.log('👆 Local notification action performed:', notification);
        this.handleLocalNotificationAction(notification);
      });
    } else {
      console.warn('⚠️ Local notification permission not granted');
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

      console.log('✅ Push token saved to Firestore');
    } catch (error) {
      console.error('❌ Error saving push token:', error);
    }
  }

  private handlePushNotificationReceived(notification: PushNotificationSchema) {
    
    console.log('📨 Handling push notification:', notification);
    
    
    if (notification.data?.type === 'panic') {
      this.handlePanicNotification(notification);
    }
  }

  private handlePushNotificationAction(notification: ActionPerformed) {
    
    console.log('👆 User tapped push notification:', notification);
    
    
    if (notification.notification.data?.actionUrl) {
      
      console.log('🔗 Navigate to:', notification.notification.data.actionUrl);
    }
  }

  private handleLocalNotificationAction(notification: any) {
    
    console.log('👆 User tapped local notification:', notification);
  }

  private handlePanicNotification(notification: PushNotificationSchema) {
    
    console.log('🚨 Panic notification received:', notification);
    
    
    this.showLocalNotification({
      title: '🚨 PANIC ALERT',
      body: notification.body || 'Emergency alert received',
      type: 'panic',
      timestamp: new Date(),
      read: false
    });
  }

  async showLocalNotification(notificationData: NotificationData) {
    try {
      if (!Capacitor.isNativePlatform()) {
        console.log('📱 Local notification (web):', notificationData);
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

      console.log('✅ Local notification scheduled');
    } catch (error) {
      console.error('❌ Error showing local notification:', error);
    }
  }

  async sendPanicNotification(familyName: string, senderName: string) {
    try {
      const notificationData: NotificationData = {
        title: '🚨 PANIC ALERT',
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

      console.log('✅ Panic notification sent');
    } catch (error) {
      console.error('❌ Error sending panic notification:', error);
    }
  }

  async sendFamilyUpdateNotification(title: string, message: string, familyName: string) {
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

      console.log('✅ Family update notification sent');
    } catch (error) {
      console.error('❌ Error sending family update notification:', error);
    }
  }

  async sendScheduleNotification(title: string, message: string, familyName: string) {
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

      console.log('✅ Schedule notification sent');
    } catch (error) {
      console.error('❌ Error sending schedule notification:', error);
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

      console.log('✅ Notification saved to history');
    } catch (error) {
      console.error('❌ Error saving notification to history:', error);
    }
  }

  async clearAllNotifications() {
    try {
      if (Capacitor.isNativePlatform()) {
        await LocalNotifications.cancel({ notifications: [] });
      }
      console.log('✅ All notifications cleared');
    } catch (error) {
      console.error('❌ Error clearing notifications:', error);
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
      console.error('❌ Error getting push token:', error);
      return null;
    }
  }

  
  async sendTestNotification() {
    try {
      const testNotification: NotificationData = {
        title: '🧪 Test Notification',
        body: 'This is a test notification to verify the system is working correctly.',
        type: 'general',
        timestamp: new Date(),
        read: false,
        actionUrl: '/home'
      };

      await this.showLocalNotification(testNotification);
      console.log('✅ Test notification sent successfully');
    } catch (error) {
      console.error('❌ Error sending test notification:', error);
    }
  }
}
