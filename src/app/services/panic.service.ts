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

    // Lock: do not allow triggering panic while an unresolved panic alert exists for the family.
    try {
      const family = await this.familyService.getUserFamily();
      if (family?.name) {
        const locked = await this.hasUnresolvedPanicAlert(family.name);
        if (locked) {
          const lockedAlert = await this.alertController.create({
            header: 'Panic already active',
            message:
              'A panic alert is already active for your family and has not been resolved yet. Please wait until an admin resolves it.',
            buttons: [{ text: 'OK', role: 'cancel', handler: () => onCancel?.() }],
            cssClass: 'panic-alert-restricted',
          });
          await lockedAlert.present();
          return;
        }
      }
    } catch (e) {
      // If we cannot verify lock state (offline/rules), fail-safe: block re-triggering.
      const lockedAlert = await this.alertController.create({
        header: 'Cannot send panic right now',
        message:
          'We could not verify if a panic alert is already active. Please check your connection and try again.',
        buttons: [{ text: 'OK', role: 'cancel', handler: () => onCancel?.() }],
        cssClass: 'panic-alert-restricted',
      });
      await lockedAlert.present();
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
            onCancel?.();
          }
        }
      ],
      cssClass: 'panic-alert-modal'
    });

    await alert.present();
  }

  private async hasUnresolvedPanicAlert(familyName: string): Promise<boolean> {
    const fam = String(familyName || '').trim();
    if (!fam) return false;
    const alertsRef = collection(this.firestore, 'Panic Alert');
    const snap = await getDocs(query(alertsRef, where('familyName', '==', fam)));
    if (snap.empty) return false;

    const rows = snap.docs.map((d) => {
      const data = d.data() as any;
      const unresolved = !this.isResolvedPanicDoc(data);
      let t = this.timestampMs(data?.createdAt ?? data?.alertTime);
      if (unresolved && t <= 0) {
        t = Date.now();
      }
      return { unresolved, t };
    });
    rows.sort((a, b) => b.t - a.t);
    const latest = rows[0];
    return Boolean(latest?.unresolved);
  }

  private isResolvedPanicDoc(data: any): boolean {
    const resolvedVal =
      data?.resolved ??
      data?.Resolved ??
      data?.isResolved ??
      data?.is_resolved ??
      data?.resolvedAt ??
      data?.resolved_at;

    const statusRaw = data?.status ?? data?.Status ?? data?.STATE ?? data?.state;
    const statusVal = String(statusRaw || '').trim().toLowerCase();

    const resolvedStr = String(resolvedVal ?? '').trim().toLowerCase();
    const resolvedTruthy =
      resolvedVal === true ||
      resolvedVal === 1 ||
      resolvedVal === '1' ||
      resolvedVal === 'true' ||
      resolvedVal === 'TRUE' ||
      resolvedStr === 'resolved' ||
      resolvedStr === 'yes';

    return (
      resolvedTruthy ||
      statusVal === 'resolved' ||
      statusVal === 'closed' ||
      statusVal === 'done'
    );
  }

  private timestampMs(v: any): number {
    if (v == null) return 0;
    if (typeof v?.toMillis === 'function') return v.toMillis();
    if (typeof v?.toDate === 'function') {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof v === 'object' && typeof v?.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    const d = new Date(v as string | number);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
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
      const alertPromises: Promise<unknown>[] = [];

      const senderName = currentUser.fullName || currentUser.email || 'Family Member';
      const senderUid = String(currentUser.uid || '').trim();
      const senderEmail = String(currentUser.email || '').trim().toLowerCase();
      const notifiedUids = new Set<string>();

      const queuePanicNotification = (
        recipientId: string,
        message: string,
        triggeredBySelf = false
      ) => {
        const rid = String(recipientId || '').trim();
        if (!rid || notifiedUids.has(rid)) {
          return;
        }
        notifiedUids.add(rid);
        alertPromises.push(
          addDoc(notificationsCollection, {
            type: 'panic_alert',
            title: 'PANIC ALERT',
            message,
            recipientId: rid,
            senderId: currentUser.uid,
            senderName,
            familyName: family.name,
            isRead: false,
            triggeredBySelf,
            createdAt: serverTimestamp(),
          })
        );
      };

      for (const member of familyMembers) {
        const memberUid = String(member.uid || '').trim();
        const memberEmail = String(member.email || '').trim().toLowerCase();
        if (!memberUid) {
          continue;
        }
        if (memberUid === senderUid) {
          continue;
        }
        if (senderEmail && memberEmail && memberEmail === senderEmail) {
          continue;
        }
        queuePanicNotification(
          memberUid,
          `Emergency alert triggered by ${senderName}`
        );
      }

      // Triggerer also sees the alert in Notifications (confirmation + history).
      if (senderUid) {
        queuePanicNotification(
          senderUid,
          'You triggered an emergency panic alert. Admin and family have been notified.',
          true
        );
      }

      await Promise.all(alertPromises);

      await this.showToast('Emergency alert sent. Admin and family notified.');
      
    } catch (error) {
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
