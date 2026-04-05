import { Injectable } from '@angular/core';
import { Firestore, collection, doc, updateDoc, query, where, getDocs, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from './auth';

export interface PasswordChangeNotification {
  id?: string;
  type: 'password_change_required';
  title: string;
  message: string;
  recipientId: string;
  senderId: string;
  senderName: string;
  familyName?: string;
  isRead: boolean;
  createdAt: any;
  passwordChanged: boolean; // Track if password has been changed
}

@Injectable({
  providedIn: 'root'
})
export class PasswordChangeService {

  constructor(
    private firestore: Firestore,
    private authService: AuthService
  ) { }

  /**
   * Create a password change notification for a parent
   */
  async createPasswordChangeNotification(
    parentUid: string,
    parentName: string,
    familyName: string,
    adminUid: string,
    adminName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const notification: PasswordChangeNotification = {
        type: 'password_change_required',
        title: 'Change Your Password',
        message: `Your account has been verified by an admin. Please change your password to secure your account.`,
        recipientId: parentUid,
        senderId: adminUid,
        senderName: adminName,
        familyName: familyName,
        isRead: false,
        createdAt: serverTimestamp(),
        passwordChanged: false
      };

      const notificationsCollection = collection(this.firestore, 'Notifications');
      await addDoc(notificationsCollection, notification);

      // Update the parent's user record to mark that password change is required
      const userDocRef = doc(this.firestore, 'Registerd', parentUid);
      await updateDoc(userDocRef, {
        passwordChangeRequired: true,
        passwordChangeCreatedAt: serverTimestamp()
      });

      return { success: true, message: 'Password change notification created' };
    } catch (error) {
      console.error('Error creating password change notification:', error);
      return { success: false, message: 'Failed to create password change notification' };
    }
  }

  /**
   * Change the parent's password (one-time only)
   */
  async changePassword(newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return { success: false, message: 'User not authenticated' };
      }

      // Check if password was already changed
      if (currentUser['passwordChanged'] === true) {
        return { success: false, message: 'Password has already been changed. You cannot change it again.' };
      }

      // Update password in Firestore
      const userDocRef = doc(this.firestore, 'Registerd', currentUser.uid);
      await updateDoc(userDocRef, {
        password: newPassword,
        passwordConfirmation: newPassword,
        passwordChanged: true,
        passwordChangeRequired: false,
        passwordChangedAt: serverTimestamp()
      });

      // Update the local user data
      const updatedUser = {
        ...currentUser,
        password: newPassword,
        passwordConfirmation: newPassword,
        passwordChanged: true
      };
      localStorage.setItem('currentUser', JSON.stringify(updatedUser));

      return { success: true, message: 'Password changed successfully' };
    } catch (error) {
      console.error('Error changing password:', error);
      return { success: false, message: 'Failed to change password' };
    }
  }

  /**
   * Mark password change notification as completed
   */
  async markPasswordChangeAsCompleted(notificationId: string): Promise<{ success: boolean; message: string }> {
    try {
      const notificationDocRef = doc(this.firestore, 'Notifications', notificationId);
      await updateDoc(notificationDocRef, {
        passwordChanged: true,
        isRead: true,
        completedAt: serverTimestamp()
      });

      return { success: true, message: 'Password change marked as completed' };
    } catch (error) {
      console.error('Error marking password change as completed:', error);
      return { success: false, message: 'Failed to mark password change as completed' };
    }
  }

  /**
   * Get pending password change notifications for current user
   */
  async getPendingPasswordChangeNotifications(): Promise<PasswordChangeNotification[]> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return [];
      }

      const notificationsCollection = collection(this.firestore, 'Notifications');
      const q = query(
        notificationsCollection,
        where('recipientId', '==', currentUser.uid),
        where('type', '==', 'password_change_required'),
        where('passwordChanged', '==', false)
      );

      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as PasswordChangeNotification));
    } catch (error) {
      console.error('Error getting password change notifications:', error);
      return [];
    }
  }

  /**
   * Check if user needs to change password
   */
  async checkPasswordChangeRequired(): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return false;
      }

      const userDocRef = doc(this.firestore, 'Registerd', currentUser.uid);
      const userSnapshot = await getDocs(query(
        collection(this.firestore, 'Registerd'),
        where('uid', '==', currentUser.uid)
      ));

      if (userSnapshot.empty) {
        return false;
      }

      const userData = userSnapshot.docs[0].data();
      return userData['passwordChangeRequired'] === true && userData['passwordChanged'] !== true;
    } catch (error) {
      console.error('Error checking password change requirement:', error);
      return false;
    }
  }
}
