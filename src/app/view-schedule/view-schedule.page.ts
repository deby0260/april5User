import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Firestore, collection, query, where, getDocs, orderBy, doc, updateDoc, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { NotificationService } from '../services/notification.service';
import { LoadingController, ToastController } from '@ionic/angular';
import { RoleAccessService, UserRole } from '../services/role-access.service';

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
    private roleAccessService: RoleAccessService
  ) { }

  async ngOnInit() {
    this.userRole = await this.roleAccessService.getUserRole();
    await this.loadScheduleData();
    this.startAutomaticScheduleCompletion();
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
      console.log('🕐 Checking for overdue schedules...');
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
            console.log(`⏰ Schedule overdue: ${schedule.childName} at ${schedule.time} (${scheduleTimeMinutes} minutes) - Current: ${currentTime} minutes`);
            schedulesToComplete.push(schedule);
          }
        }
      }

      
      for (const schedule of schedulesToComplete) {
        await this.automaticallyCompleteSchedule(schedule);
      }

    } catch (error) {
      console.error('❌ Error checking overdue schedules:', error);
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
      console.error('❌ Error parsing time:', timeString, error);
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
      console.log('🤖 Automatically completing schedule:', schedule.childName);

  
      
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
        console.log('✅ Automatically removed completed schedule from view');
      }

    } catch (error) {
      console.error('❌ Error automatically completing schedule:', error);
    }
  }

  async loadScheduleData() {
    const loading = await this.loadingController.create({
      message: 'Loading schedules...'
    });
    await loading.present();

    try {
      this.isLoading = true;
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        await loading.dismiss();
        return;
      }

      
      const family = await this.familyService.getUserFamily();
      if (!family) {
        await loading.dismiss();
        return;
      }

      this.familyName = family.name;

      
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const familySchedulesQuery = query(
        schedulesCollection,
        where('Family Name', '==', family.name)
      );
      
      const querySnapshot = await getDocs(familySchedulesQuery);

      this.schedules = [];
      console.log('📊 Processing schedules from Firestore...');

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        const scheduleStatus = data['Status'] || 'pending';
        const scheduleDate = data['Date'] || '';

        console.log(`📅 Schedule ${doc.id}: Status = "${scheduleStatus}", Child = "${data['Childs Name']}", Date = "${scheduleDate}"`);

        
        if (scheduleStatus === 'pending') {
          console.log(`✅ Including pending schedule: ${data['Childs Name']}`);
          this.schedules.push({
            id: doc.id,
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
            completedBy: data['Completed By']
          });
        } else {
          console.log(`❌ Filtering out completed schedule: ${data['Childs Name']}`);
        }
      });

      this.schedules = this.mergeDuplicateSchedules(this.schedules);

      // Soonest pickup first: calendar date, then time of day (not createdAt / doc order)
      this.schedules.sort((a, b) => this.compareSchedulesChronologically(a, b));

      console.log(`Loaded ${this.schedules.length} schedules for family: ${family.name}`);
      console.log('Schedules data:', this.schedules);
      console.log('Family name used for query:', family.name);

    } catch (error) {
      console.error('Error loading schedules:', error);
    } finally {
      this.isLoading = false;
      await loading.dismiss();
    }
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

  async markScheduleAsDone(schedule: ScheduleItem) {
    console.log('🔄 markScheduleAsDone called for schedule:', schedule);

    const loading = await this.loadingController.create({
      message: 'Marking schedule as completed...'
    });
    await loading.present();

    try {
      const currentUser = this.authService.getCurrentUser();
      console.log('👤 Current user:', currentUser);

      if (!currentUser) {
        await loading.dismiss();
        await this.showToast('User not authenticated');
        return;
      }

      
      const docIds = this.allScheduleDocIds(schedule);
      console.log('📝 Updating schedule doc(s) in Firestore:', docIds.join(', '));
      for (const docId of docIds) {
        const scheduleDoc = doc(this.firestore, 'Schedules', docId);
        await updateDoc(scheduleDoc, {
          'Status': 'completed',
          'Completed At': serverTimestamp(),
          'Completed By': currentUser.fullName || currentUser.email || 'Unknown User'
        });
      }
      console.log('✅ Schedule(s) updated in Firestore');

      
      await this.sendCompletionNotification(schedule, currentUser);

      
      await this.sendPickupNotificationToParents(schedule, currentUser);

      
      await this.createPickupNotificationLog(schedule, currentUser);

      
      await this.sendCapacitorScheduleNotification(schedule, currentUser);

      
      console.log('🗑️ Removing schedule from local array');
      const scheduleIndex = this.schedules.findIndex(s => s.id === schedule.id);
      console.log('📍 Schedule index found:', scheduleIndex);

      if (scheduleIndex !== -1) {
        this.schedules.splice(scheduleIndex, 1);
        console.log('✅ Schedule removed from local array. Remaining schedules:', this.schedules.length);
      } else {
        console.log('❌ Schedule not found in local array');
      }

      await loading.dismiss();
      await this.showToast('✅ Schedule completed and logged successfully!');

    } catch (error) {
      await loading.dismiss();
      console.error('Error marking schedule as done:', error);
      await this.showToast('Error marking schedule as completed. Please try again.');
    }
  }

  async sendCompletionNotification(schedule: ScheduleItem, currentUser: any) {
    try {
      if (!schedule.fetcherUID) {
        console.log('No fetcher UID found for notification');
        return;
      }

      
      const notificationData = {
        type: 'schedule_completion',
        title: 'Schedule Completed',
        message: `The pickup schedule for ${schedule.childName} on ${schedule.days} at ${schedule.time} has been marked as completed.`,
        recipientId: schedule.fetcherUID,
        senderId: currentUser.uid, 
        senderName: currentUser.fullName || currentUser.email || 'Family Member',
        familyName: schedule.familyName,
        scheduleId: schedule.id,
        scheduleDate: schedule.date,
        scheduleTime: schedule.time,
        scheduleDays: schedule.days,
        childName: schedule.childName,
        childGrade: schedule.childGrade,
        isRead: false,
        createdAt: serverTimestamp()
      };

      
      const notificationsCollection = collection(this.firestore, 'Notifications');
      await addDoc(notificationsCollection, notificationData);

      console.log('Completion notification sent to:', schedule.fetcherName);
    } catch (error) {
      console.error('Error sending completion notification:', error);
    }
  }

  async sendPickupNotificationToParents(schedule: ScheduleItem, currentUser: any) {
    try {
      
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      const familyMembers = await this.familyService.getFamilyMembers(family.name);
      const parentsAndOwners = familyMembers.filter(member =>
        member.role === 'owner' || member.role === 'parent'
      );

      
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const notificationPromises = [];

      for (const parent of parentsAndOwners) {
        
        if (parent.uid === currentUser.uid) continue;

        const pickupNotificationData = {
          type: 'pickup_completion',
          title: `${schedule.childName} picked up`,
          message: `${schedule.childName} has been picked up by ${currentUser.fullName || currentUser.email || 'Unknown'}`,
          recipientId: parent.uid,
          senderId: currentUser.uid,
          senderName: currentUser.fullName || currentUser.email || 'Family Member',
          familyName: schedule.familyName,
          childName: schedule.childName,
          childGrade: schedule.childGrade,
          fetcherName: currentUser.fullName || currentUser.email || 'Unknown',
          completedBy: currentUser.fullName || currentUser.email || 'Unknown',
          scheduleId: schedule.id,
          scheduleDate: schedule.date,
          scheduleTime: schedule.time,
          isRead: false,
          createdAt: serverTimestamp()
        };

        notificationPromises.push(addDoc(notificationsCollection, pickupNotificationData));
      }

      
      await Promise.all(notificationPromises);

      console.log(`Pickup notifications sent to ${parentsAndOwners.length} parents/owners`);
    } catch (error) {
      console.error('Error sending pickup notifications to parents:', error);
    }
  }

  async createPickupNotificationLog(schedule: ScheduleItem, currentUser: any) {
    try {
      console.log('📝 Creating pickup notification log for:', schedule.childName);

      
      const pickupNotificationData = {
        type: 'pickup_completion',
        title: `${schedule.childName} picked up`,
        message: `${schedule.childName} was successfully picked up by ${currentUser.fullName || currentUser.email || 'Unknown User'}`,
        childName: schedule.childName,
        childGrade: schedule.childGrade,
        fetcherName: schedule.fetcherName,
        completedBy: currentUser.fullName || currentUser.email || 'Unknown User',
        familyName: schedule.familyName,
        scheduleId: schedule.id,
        scheduleDate: schedule.date,
        scheduleTime: schedule.time,
        scheduleDays: schedule.days,
        isRead: false,
        createdAt: serverTimestamp()
      };

      console.log('📄 Notification data to save:', pickupNotificationData);

      
      const notificationsCollection = collection(this.firestore, 'Notifications');
      await addDoc(notificationsCollection, pickupNotificationData);
      
      console.log('✅ Pickup notification logged successfully');      
    } catch (error) {
      console.error('❌ Error creating pickup notification log:', error);
    }
  }

  async createAutomaticPickupNotificationLog(schedule: ScheduleItem, completedBy: string) {
    try {
      console.log('🤖 Creating automatic pickup notification log for:', schedule.childName);

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

      console.log('📄 Automatic notification data to save:', pickupNotificationData);

      const notificationsCollection = collection(this.firestore, 'Notifications');
      const docRef = await addDoc(notificationsCollection, pickupNotificationData);

      console.log('✅ Automatic pickup notification logged successfully with ID:', docRef.id);
    } catch (error) {
      console.error('❌ Error creating automatic pickup notification log:', error);
    }
  }

  async sendAutomaticCapacitorNotification(schedule: ScheduleItem) {
    try {
      const title = '🕐 Schedule Auto-Completed';
      const message = `${schedule.childName} pickup time has passed - automatically marked as completed`;

      await this.notificationService.sendScheduleNotification(
        title,
        message,
        schedule.familyName
      );

      console.log('✅ Automatic Capacitor notification sent');
    } catch (error) {
      console.error('❌ Error sending automatic Capacitor notification:', error);
    }
  }

  async sendCapacitorScheduleNotification(schedule: ScheduleItem, currentUser: any) {
    try {
      const title = '📅 Schedule Completed';
      const message = `${schedule.childName} has been picked up by ${currentUser.fullName || currentUser.email || 'Unknown User'}`;

      await this.notificationService.sendScheduleNotification(
        title,
        message,
        schedule.familyName
      );

      console.log('✅ Capacitor schedule notification sent');
    } catch (error) {
      console.error('❌ Error sending Capacitor schedule notification:', error);
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

  canMarkAsDone(schedule: ScheduleItem): boolean {
    
    if (schedule.status === 'completed') {
      return false;
    }

    const ymd = this.toLocalYmd(schedule.date);
    const parts = ymd.split('-').map((n) => parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return false;
    }
    const [y, m, d] = parts;
    const scheduleDay = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return scheduleDay <= today;
  }

  goBack() {
    this.location.back();
  }

  navigateTo(route: string) {
    this.router.navigate([route]);
  }

  async triggerPanic() {
    await this.panicService.triggerPanicAlert();
  }
}
