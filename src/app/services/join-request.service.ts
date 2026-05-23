import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc, query, where, getDocs, doc, updateDoc, deleteDoc, serverTimestamp, getDoc } from '@angular/fire/firestore';
import { AuthService, UserData } from './auth';

export interface JoinRequest {
  id?: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  requesterContact: string;
  familyName: string;
  familyOwnerId: string;
  status: 'pending' | 'approved' | 'denied';
  role?: 'parent' | 'companion';
  createdAt: any;
  updatedAt?: any;
}

export interface FamilyNotification {
  id?: string;
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
    | 'panic_alert_resolved'
    | 'password_change_required';
  title: string;
  message: string;
  recipientId: string;
  senderId: string;
  senderName: string;
  joinRequestId?: string;
  familyName?: string;
  isRead: boolean;
  createdAt: any;
}

@Injectable({
  providedIn: 'root'
})
export class JoinRequestService {

  constructor(
    private firestore: Firestore,
    private authService: AuthService
  ) { }

  
  async createJoinRequest(familyName: string, familyOwnerId: string): Promise<{ success: boolean; message: string }> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return { success: false, message: 'User not authenticated' };
      }

      
      const existingRequest = await this.checkExistingRequest(currentUser.uid, familyName);
      if (existingRequest) {
        return { success: false, message: 'You already have a pending request for this family' };
      }

      
      const joinRequest: JoinRequest = {
        requesterId: currentUser.uid,
        requesterName: currentUser.fullName,
        requesterEmail: currentUser.email,
        requesterContact: currentUser.contactNumber,
        familyName: familyName,
        familyOwnerId: familyOwnerId,
        status: 'pending',
        createdAt: serverTimestamp()
      };

      const joinRequestsCollection = collection(this.firestore, 'Join Requests');
      const docRef = await addDoc(joinRequestsCollection, joinRequest);

      
      await this.createNotification({
        type: 'join_request',
        title: 'Join Request',
        message: `${currentUser.fullName} wants to join your family "${familyName}"`,
        recipientId: familyOwnerId,
        senderId: currentUser.uid,
        senderName: currentUser.fullName,
        joinRequestId: docRef.id,
        familyName: familyName,
        isRead: false,
        createdAt: serverTimestamp()
      });

      return { success: true, message: 'Join request sent successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to send join request' };
    }
  }

  
  async checkExistingRequest(userId: string, familyName: string): Promise<boolean> {
    try {
      const joinRequestsCollection = collection(this.firestore, 'Join Requests');
      const q = query(
        joinRequestsCollection,
        where('requesterId', '==', userId),
        where('familyName', '==', familyName),
        where('status', '==', 'pending')
      );
      
      const querySnapshot = await getDocs(q);
      return !querySnapshot.empty;
    } catch (error) {
      return false;
    }
  }

  
  async getUserPendingRequests(userId: string): Promise<JoinRequest[]> {
    try {
      const joinRequestsCollection = collection(this.firestore, 'Join Requests');
      const q = query(
        joinRequestsCollection,
        where('requesterId', '==', userId),
        where('status', '==', 'pending')
      );
      
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as JoinRequest));
    } catch (error) {
      return [];
    }
  }

  
  async cancelJoinRequest(requestId: string): Promise<{ success: boolean; message: string }> {
    try {
      const requestDoc = doc(this.firestore, 'Join Requests', requestId);
      await deleteDoc(requestDoc);
      
      return { success: true, message: 'Join request cancelled successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to cancel join request' };
    }
  }

  
  async approveJoinRequest(requestId: string, role: 'parent' | 'companion' = 'companion'): Promise<{ success: boolean; message: string }> {
    try {
      const requestDoc = doc(this.firestore, 'Join Requests', requestId);
      await updateDoc(requestDoc, {
        status: 'approved',
        role: role,
        updatedAt: serverTimestamp()
      });

      return { success: true, message: 'Join request approved successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to approve join request' };
    }
  }

  
  async denyJoinRequest(requestId: string): Promise<{ success: boolean; message: string }> {
    try {
      const requestDoc = doc(this.firestore, 'Join Requests', requestId);
      await updateDoc(requestDoc, {
        status: 'denied',
        updatedAt: serverTimestamp()
      });

      return { success: true, message: 'Join request denied successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to deny join request' };
    }
  }

  
  async createNotification(notification: FamilyNotification): Promise<void> {
    try {
      const notificationsCollection = collection(this.firestore, 'Notifications');
      await addDoc(notificationsCollection, notification);
    } catch (error) {
    }
  }

  
  async getUserNotifications(userId: string): Promise<FamilyNotification[]> {
    try {
      const notificationsCollection = collection(this.firestore, 'Notifications');
      const q = query(
        notificationsCollection,
        where('recipientId', '==', userId)
      );
      
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }) as FamilyNotification);
    } catch (error) {
      return [];
    }
  }

  
  async markNotificationAsRead(notificationId: string): Promise<void> {
    try {
      const notificationDoc = doc(this.firestore, 'Notifications', notificationId);
      await updateDoc(notificationDoc, {
        isRead: true
      });
    } catch (error) {
    }
  }

  
  async getJoinRequestById(requestId: string): Promise<JoinRequest | null> {
    try {
      const requestRef = doc(this.firestore, 'Join Requests', requestId);
      const snap = await getDoc(requestRef);
      if (snap.exists()) {
        return {
          id: snap.id,
          ...(snap.data() as any)
        } as JoinRequest;
      }
      return null;
    } catch (error) {
      return null;
    }
  }
}
