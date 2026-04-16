import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { AuthService } from '../services/auth';
import { JoinRequestService, FamilyNotification, JoinRequest } from '../services/join-request.service';
import { FamilyService } from '../services/family.service';
import { PasswordChangeService } from '../services/password-change.service';
import { AlertController, ToastController, LoadingController, ModalController } from '@ionic/angular';

interface Notification {
  id: string;
  type: 'schedule' | 'request' | 'success' | 'join_request' | 'join_approved' | 'join_denied' | 'schedule_completion' | 'schedule_assignment' | 'pickup_completion' | 'panic_alert' | 'password_change_required';
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
  notifications: Notification[] = [];
  isLoading: boolean = false;

  constructor(
    private location: Location,
    private authService: AuthService,
    private joinRequestService: JoinRequestService,
    private familyService: FamilyService,
    private passwordChangeService: PasswordChangeService,
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

      if (currentUser) {
        const realNotifications = await this.joinRequestService.getUserNotifications(currentUser.uid);

        this.notifications = await Promise.all(
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
              message: notification.type === 'panic_alert' && notification.senderName
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
              passwordChanged: (notification as any).passwordChanged === true
            } as Notification;
          })
        );

        
        this.notifications.sort((a, b) => {
          return b.sortTime - a.sortTime;
        });
      }
    } catch (error) {
      console.error('Error loading notifications:', error);
    } finally {
      this.isLoading = false;
    }
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

  async onNotificationClick(notification: Notification) {
    
    if (!notification.isRead && notification.id) {
      await this.joinRequestService.markNotificationAsRead(notification.id);
      notification.isRead = true;
    }

    
    if (notification.type === 'join_request' && notification.joinRequestId) {
      if (notification.joinRequestStatus && notification.joinRequestStatus !== 'pending') {
        return;
      }
      await this.handleJoinRequestNotification(notification);
    }

    
    if (notification.type === 'password_change_required' && !notification.passwordChanged) {
      await this.handlePasswordChangeNotification(notification);
    }
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

  getNotificationIcon(type: string): string {
    switch (type) {
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
