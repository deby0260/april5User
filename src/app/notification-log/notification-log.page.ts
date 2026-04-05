import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, query, where, getDocs, doc, deleteDoc, addDoc } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { LoadingController, ToastController, AlertController } from '@ionic/angular';

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

  constructor(
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private alertController: AlertController
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

      querySnapshot.forEach((doc) => {
        const data = doc.data() as any;
        console.log('📄 Processing notification:', doc.id, data);

        const scheduleTime = data['scheduleTime'] || '';
        
        const completedBy = data['fetcherName'] || data['completedBy'] || 'Unknown';

        const notification: PickupNotification = {
          id: doc.id,
          time: this.formatTime(data['createdAt']),
          title: `${data['childName'] || 'Child'} picked up`,
          subtitle: scheduleTime ? `by ${completedBy} at ${scheduleTime}` : `by ${completedBy}`,
          childName: data['childName'] || 'Unknown Child',
          fetcherName: data['fetcherName'] || 'Unknown Fetcher',
          completedBy: completedBy,
          scheduleTime: scheduleTime,
          createdAt: data['createdAt'],
          type: data['type']
        };
        console.log('✅ Created notification object:', notification);
        allNotifications.push(notification);
      });

      
      allNotifications.sort((a, b) => {
        const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return dateB.getTime() - dateA.getTime();
      });

      
      this.categorizeNotifications(allNotifications);

    } catch (error) {
      console.error('Error loading pickup notifications:', error);
    } finally {
      this.isLoading = false;
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
      
      const notificationDoc = doc(this.firestore, 'Notifications', notificationId);
      await deleteDoc(notificationDoc);

      
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

  navigateToNotifications() {
    this.router.navigate(['/notifications']);
  }

  async triggerPanicAlert() {
    await this.panicService.triggerPanicAlert();
  }



  onNotificationClick(notification: PickupNotification) {
  
    this.showNotificationDetails(notification);
  }

  async showNotificationDetails(notification: PickupNotification) {
    const alert = await this.alertController.create({
      header: 'Pickup Details',
      message: `
        <strong>Child:</strong> ${notification.childName}<br>
        <strong>Picked up by:</strong> ${notification.completedBy}<br>
        <strong>Time:</strong> ${notification.time}<br>
        ${notification.date ? `<strong>Date:</strong> ${notification.date}<br>` : ''}
      `,
      buttons: ['OK']
    });

    await alert.present();
  }
}
