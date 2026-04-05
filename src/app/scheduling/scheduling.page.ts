import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService, FamilyMember } from '../services/family.service';
import { PanicService } from '../services/panic.service';
import { LoadingController, ToastController } from '@ionic/angular';
import { RoleAccessService } from '../services/role-access.service';

interface ScheduleData {
  fetcherName: string;
  fetcherUID: string;
  selectedChildren: any[];
  selectedDays: string[];
  selectedDate: string;
  selectedTime: string;
  familyName: string;
  parentName: string;
  companionName: string;
}

@Component({
  selector: 'app-scheduling',
  templateUrl: './scheduling.page.html',
  styleUrls: ['./scheduling.page.scss'],
  standalone: false
})
export class SchedulingPage implements OnInit {
  scheduleData: ScheduleData = {
    fetcherName: '',
    fetcherUID: '',
    selectedChildren: [],
    selectedDays: [],
    selectedDate: '',
    selectedTime: '00:00',
    familyName: '',
    parentName: '',
    companionName: ''
  };

  familyMembers: FamilyMember[] = [];
  children: any[] = [];
  currentUserRole: string = '';
  canManageSchedule: boolean = false;
  minDate: string = '';
  maxDate: string = '';

  constructor(
    private location: Location,
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private panicService: PanicService,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private roleAccessService: RoleAccessService
  ) { }

  async ngOnInit() {
    
    const today = new Date();
    this.minDate = today.toISOString();

    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    this.maxDate = maxDate.toISOString();

    await this.loadFamilyData();
    await this.loadUserRole();
  }

  async loadFamilyData() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      
      const family = await this.familyService.getUserFamily();
      if (!family) return;

      this.scheduleData.familyName = family.name;
      this.scheduleData.parentName = currentUser.fullName || currentUser.email || 'Parent';

      
      this.familyMembers = await this.familyService.getFamilyMembers(family.name);

      
      this.children = await this.familyService.getFamilyChildren(family.name);

      console.log('Family members loaded:', this.familyMembers);
      console.log('Children loaded:', this.children);
    } catch (error) {
      console.error('Error loading family data:', error);
    }
  }

  async loadUserRole() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const family = await this.familyService.getUserFamily();
      if (!family) return;

      // Use RoleAccessService to get the correct role (checks Registerd collection first)
      const userRole = await this.roleAccessService.getUserRole();

      if (userRole) {
        this.currentUserRole = userRole.role;
        this.canManageSchedule = userRole.canAccessScheduling;
        console.log('✅ Scheduling page - User role:', this.currentUserRole, 'Can manage schedule:', this.canManageSchedule);
      } else {
        // Fallback to checking family members
        const members = await this.familyService.getFamilyMembers(family.name);
        const userMember = members.find(member => member.uid === currentUser.uid);

        if (userMember) {
          this.currentUserRole = userMember.role;
          this.canManageSchedule = userMember.role === 'owner' || userMember.role === 'parent';
          console.log('⚠️ Scheduling page - Fallback role from members:', this.currentUserRole);
        }
      }
    } catch (error) {
      console.error('Error loading user role:', error);
    }
  }

  getAvailableFetchers(): FamilyMember[] {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return [];

    
    if (this.currentUserRole === 'owner') {
      
      return this.familyMembers.filter(member =>
        member.role === 'parent' || member.role === 'companion'
      );
    } else if (this.currentUserRole === 'parent') {
      
      return this.familyMembers.filter(member =>
        member.role === 'companion'
      );
    }

    return [];
  }

  getSelectedMember(): FamilyMember | null {
    if (!this.scheduleData.fetcherUID) return null;
    return this.familyMembers.find(member => member.uid === this.scheduleData.fetcherUID) || null;
  }

  onFetcherSelected(event: any) {
    const member = event.detail.value;
    if (member) {
      this.scheduleData.fetcherName = member.name;
      this.scheduleData.fetcherUID = member.uid;
      this.scheduleData.companionName = member.name;
      console.log('Fetcher selected:', member.name);
    }
  }

  toggleChildSelection(child: any) {
    const index = this.scheduleData.selectedChildren.findIndex(c => c.name === child.name);
    if (index > -1) {
      this.scheduleData.selectedChildren.splice(index, 1);
    } else {
      this.scheduleData.selectedChildren.push(child);
    }
  }

  isChildSelected(child: any): boolean {
    return this.scheduleData.selectedChildren.some(c => c.name === child.name);
  }

  selectAllChildren() {
    this.scheduleData.selectedChildren = [...this.children];
  }

  clearAllChildren() {
    this.scheduleData.selectedChildren = [];
  }

  toggleDay(day: string) {
    
    if (this.scheduleData.selectedDays.includes(day)) {
      
      this.scheduleData.selectedDays = [];
    } else {
      
      this.scheduleData.selectedDays = [day];
    }

    
    this.scheduleData.selectedDate = '';
  }

  onDateChange(event: any) {
    const selectedDate = event.detail.value;
    if (selectedDate) {
      
      this.scheduleData.selectedDate = selectedDate.split('T')[0];
    }
  }

  getMinDate(): string {
    return this.minDate;
  }

  getMaxDate(): string {
    return this.maxDate;
  }

  isDateEnabled = (dateIsoString: string) => {
    
    if (this.scheduleData.selectedDays.length === 0) {
      return true;
    }

    const date = new Date(dateIsoString);
    const dayOfWeek = date.getDay(); 
    
    const dayMap: { [key: string]: number } = {
      'Sunday': 0,
      'Monday': 1,
      'Tuesday': 2,
      'Wednesday': 3,
      'Thursday': 4,
      'Friday': 5,
      'Saturday': 6
    };

    return this.scheduleData.selectedDays.some(day => dayMap[day] === dayOfWeek);
  }

  getFormattedDate(): string {
    if (!this.scheduleData.selectedDate) return 'Select Date';

    const date = new Date(this.scheduleData.selectedDate);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  async saveSchedule() {
    
    if (!this.canManageSchedule) {
      await this.showToast('You do not have permission to create schedules');
      return;
    }

    if (!this.scheduleData.fetcherName) {
      await this.showToast('Please select a fetcher');
      return;
    }

    if (this.scheduleData.selectedDays.length === 0) {
      await this.showToast('Please select a day');
      return;
    }

    if (this.scheduleData.selectedDays.length > 1) {
      await this.showToast('Please select only one day at a time');
      return;
    }

    if (!this.scheduleData.selectedDate) {
      await this.showToast('Please select a date');
      return;
    }

    if (!this.scheduleData.selectedTime) {
      await this.showToast('Please select a time');
      return;
    }

    if (this.scheduleData.selectedChildren.length === 0) {
      await this.showToast('Please select at least one child');
      return;
    }

    const loading = await this.loadingController.create({
      message: 'Saving schedule...'
    });
    await loading.present();

    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        await loading.dismiss();
        await this.showToast('User not authenticated');
        return;
      }

      
      const schedulesCollection = collection(this.firestore, 'Schedules');
      const schedulePromises = [];

      for (const child of this.scheduleData.selectedChildren) {
        const scheduleData = {
          'Childs Grade': child.grade || '',
          'Childs Name': child.name || '',
          'Companions Name': this.scheduleData.companionName,
          'Date': this.scheduleData.selectedDate,
          'Parent Name': this.scheduleData.parentName,
          'Time': this.scheduleData.selectedTime,
          'Family Name': this.scheduleData.familyName,
          'Days': this.scheduleData.selectedDays.join(', '),
          'Fetcher UID': this.scheduleData.fetcherUID,
          'Creator UID': currentUser.uid,
          'Created At': serverTimestamp(),
          'Status': 'pending',
          'id': '' 
        };

        console.log('Saving schedule data:', scheduleData);

        schedulePromises.push(addDoc(schedulesCollection, scheduleData));
      }

      
      await Promise.all(schedulePromises);

      
      await this.sendScheduleNotification();

      await loading.dismiss();
      await this.showToast(`Schedule saved successfully for ${this.scheduleData.selectedChildren.length} child(ren)!`);

      console.log(`Saved ${this.scheduleData.selectedChildren.length} schedules`);
      this.goBack();

    } catch (error) {
      await loading.dismiss();
      console.error('Error saving schedule:', error);
      await this.showToast('Error saving schedule. Please try again.');
    }
  }

  async sendScheduleNotification() {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser || !this.scheduleData.fetcherUID) return;

      const childrenNames = this.scheduleData.selectedChildren.map(child => child.name).join(', ');
      const childCount = this.scheduleData.selectedChildren.length;
      const childText = childCount === 1 ? 'child' : 'children';

      
      const notificationData = {
        type: 'schedule_assignment',
        title: 'New Schedule Assignment',
        message: `You have been scheduled to pick up ${childCount} ${childText} (${childrenNames}) on ${this.scheduleData.selectedDays.join(', ')} at ${this.scheduleData.selectedTime}`,
        recipientId: this.scheduleData.fetcherUID, 
        senderId: currentUser.uid, 
        senderName: currentUser.fullName || currentUser.email || 'Family Member',
        familyName: this.scheduleData.familyName,
        scheduleDate: this.scheduleData.selectedDate,
        scheduleTime: this.scheduleData.selectedTime,
        scheduleDays: this.scheduleData.selectedDays.join(', '),
        childrenNames: childrenNames,
        childrenCount: childCount,
        isRead: false,
        createdAt: serverTimestamp()
      };

      
      const notificationsCollection = collection(this.firestore, 'Notifications');
      await addDoc(notificationsCollection, notificationData);

      console.log('Schedule notification sent to:', this.scheduleData.fetcherName);
    } catch (error) {
      console.error('Error sending notification:', error);
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

  navigateTo(route: string) {
    this.router.navigate([route]);
  }

  goBack() {
    this.location.back();
  }

  async triggerPanic() {
    await this.panicService.triggerPanicAlert();
  }
}
