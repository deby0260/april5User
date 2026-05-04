import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc, serverTimestamp, query, where, getDocs } from '@angular/fire/firestore';
import { AuthService } from './auth';
import { FamilyService } from './family.service';
import { NotificationService } from './notification.service';
import { AlertController, ToastController } from '@ionic/angular';
import { JoinRequestService } from './join-request.service';
import { BehaviorSubject } from 'rxjs';

export type ActiveEmergencyBannerState = {
  triggeredByName: string;
  createdAtMs: number;
  familyName: string;
};

@Injectable({
  providedIn: 'root'
})
export class PanicService {
  private activeEmergencySubject = new BehaviorSubject<ActiveEmergencyBannerState | null>(null);
  activeEmergency$ = this.activeEmergencySubject.asObservable();

  constructor(
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private notificationService: NotificationService,
    private alertController: AlertController,
    private toastController: ToastController,
    private joinRequestService: JoinRequestService
  ) { }

  setActiveEmergencyBanner(state: ActiveEmergencyBannerState | null): void {
    this.activeEmergencySubject.next(state);
  }

  async triggerPanicAlert(onCancel?: () => void, onSend?: () => void): Promise<void> {
    
    const hasFamily = await this.familyService.checkUserHasFamily();

    if (!hasFamily) {
      const restrictedAlert = await this.alertController.create({
        header: 'Access Restricted',
        message: 'You must join or create a family before using the panic alert feature.',
        buttons: [
          {
            text: 'OK',
            role: 'cancel',
            handler: () => {
              onCancel?.();
            }
          }
        ],
        cssClass: 'panic-alert-restricted'
      });
      await restrictedAlert.present();
      return;
    }

    const alert = await this.alertController.create({
      header: 'EMERGENCY PANIC ALERT',
      message: 'This will immediately notify all family members and administrators about your emergency.',
      backdropDismiss: false,
      buttons: [

        {
          text: 'SEND ALERT',
          cssClass: 'panic-send-btn',
          handler: () => {
            this.sendPanicAlert();
            onSend?.();
          }
        },
        {
          text: 'CANCEL',
          role: 'cancel',
          cssClass: 'panic-cancel-btn',
          handler: () => {
            console.log('Panic alert cancelled');
            onCancel?.();
          }
        }
      ],
      cssClass: 'panic-alert-modal'
    });

    await alert.present();
  }

  private async sendPanicAlert(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        await this.showToast('Error: User not authenticated');
        return;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        await this.showToast('Error: No family found');
        return;
      }

      const familyMembers = await this.familyService.getFamilyMembers(family.name);
      
      const currentUserProfile = familyMembers.find(member => member.uid === currentUser.uid);
      
      const childrenInfo = await this.familyService.getFamilyChildren(family.name);
      const childrenNames = childrenInfo.map((child: any) => child.name).join(', ') || 'No children listed';
      
      const fetchers = familyMembers.filter(member => 
        member.role === 'parent' || member.role === 'owner' || member.role === 'companion'
      );
      const fetchersInfo = fetchers.map(fetcher => ({
        name: fetcher.name || fetcher.email || 'Unknown',
        contact: fetcher.contactNumber || 'No contact',
        profile: fetcher.profilePicture || ''
      }));

      const panicAlertCollection = collection(this.firestore, 'Panic Alert');
      const panicAlertData = {
        alertTriggeredBy: currentUser.fullName || currentUser.email || 'Unknown User',
        alertTriggeredById: currentUser.uid,
        familyName: family.name,
        familyId: family.id || '',
        
        "Childs Name": childrenNames,
        
        "Parents Name": currentUserProfile?.name || currentUser.fullName || currentUser.email || 'Unknown',
        "uid of the Parent": currentUser.uid,
        
        "Fetchers Name": fetchersInfo.map(f => f.name).join(', ') || 'No fetchers available',
        "Fetchers Contact Number": fetchersInfo.map(f => f.contact).join(', ') || 'No contact available',
        "Fetchers Profile": fetchersInfo.map(f => f.profile).join(', ') || 'No profile available',
        
        emergencyType: 'Panic Button Alert',
        location: 'Unknown', 
        deviceInfo: navigator.userAgent || 'Unknown device',
        
        alertTime: serverTimestamp(),
        createdAt: serverTimestamp(),
        
        status: 'Active',
        resolved: false,
        adminNotified: true,
        
        totalFamilyMembers: familyMembers.length,
        totalChildren: childrenInfo.length,
        totalFetchers: fetchers.length
      };

      this.setActiveEmergencyBanner({
        triggeredByName: currentUser.fullName || currentUser.email || 'Unknown User',
        createdAtMs: Date.now(),
        familyName: family.name
      });

      
      await addDoc(panicAlertCollection, panicAlertData);
      
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const alertPromises = [];

      for (const member of familyMembers) {
        if (member.uid === currentUser.uid) continue;

        const panicNotificationData = {
          type: 'panic_alert',
          title: 'PANIC ALERT',
          message: `Emergency alert triggered by ${currentUser.fullName || currentUser.email || 'Family Member'}`,
          recipientId: member.uid,
          senderId: currentUser.uid,
          senderName: currentUser.fullName || currentUser.email || 'Family Member',
          familyName: family.name,
          isRead: false,
          createdAt: serverTimestamp()
        };

        alertPromises.push(addDoc(notificationsCollection, panicNotificationData));
      }

      await Promise.all(alertPromises);

      await this.notificationService.sendPanicNotification(
        family.name,
        currentUser.fullName || currentUser.email || 'Family Member'
      );

      console.log('Panic alert saved to database and sent to family members');
      await this.showToast('Emergency alert sent. Admin and family notified.');
      
    } catch (error) {
      console.error('Error sending panic alert:', error);
      await this.showToast('Error sending panic alert');
    }
  }

  private async showToast(message: string): Promise<void> {
    const toast = await this.toastController.create({
      message: message,
      duration: 3000,
      position: 'bottom'
    });
    await toast.present();
  }
}
