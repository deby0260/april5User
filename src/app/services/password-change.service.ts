import { Injectable } from '@angular/core';
import { Firestore, collection, doc, updateDoc, query, where, getDocs, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from './auth';
import {
  Auth as FirebaseAuth,
  EmailAuthProvider,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  updatePassword,
} from '@angular/fire/auth';

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
    private authService: AuthService,
    private auth: FirebaseAuth
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
      return { success: false, message: 'Failed to create password change notification' };
    }
  }

  /**
   * Sync Firebase Auth password when possible (verified-parent modal has no "current password" field).
   */
  private async syncFirebaseAuthPassword(
    email: string,
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    let firebaseUser = this.auth.currentUser;

    if (!firebaseUser && email && currentPassword) {
      try {
        const cred = await signInWithEmailAndPassword(this.auth, email, currentPassword);
        firebaseUser = cred.user;
      } catch (e: any) {
        const code = String(e?.code || '');
        if (code.includes('auth/user-not-found') || code.includes('auth/invalid-credential')) {
          return { ok: true };
        }
        return { ok: false, message: 'Could not update login password. Please try again.' };
      }
    }

    if (!firebaseUser?.email) {
      return { ok: true };
    }

    try {
      await updatePassword(firebaseUser, newPassword);
      return { ok: true };
    } catch (e: any) {
      const code = String(e?.code || '');
      if (code.includes('auth/requires-recent-login') && currentPassword) {
        try {
          const cred = EmailAuthProvider.credential(firebaseUser.email, currentPassword);
          await reauthenticateWithCredential(firebaseUser, cred);
          await updatePassword(firebaseUser, newPassword);
          return { ok: true };
        } catch {
          return {
            ok: false,
            message: 'Please log out, log in with your current password, then change it again.',
          };
        }
      }
      if (code.includes('auth/weak-password')) {
        return { ok: false, message: 'Password is too weak. Please choose a stronger password.' };
      }
      return { ok: false, message: 'Failed to update login password. Please try again.' };
    }
  }

  /**
   * Change the parent's password (one-time only). Always saves to Registerd; updates Firebase Auth when available.
   */
  async changePassword(newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser?.uid) {
        return { success: false, message: 'User not authenticated' };
      }

      if (currentUser.passwordChanged === true) {
        return { success: false, message: 'Password has already been changed. You cannot change it again.' };
      }

      const email = String(currentUser.email || '').trim();
      const currentPassword = String(currentUser.password || '');

      const authSync = await this.syncFirebaseAuthPassword(email, currentPassword, newPassword);
      if (!authSync.ok) {
        return { success: false, message: authSync.message };
      }

      const userDocRef = doc(this.firestore, 'Registerd', currentUser.uid);
      await updateDoc(userDocRef, {
        password: newPassword,
        passwordConfirmation: newPassword,
        passwordChanged: true,
        passwordChangeRequired: false,
        passwordChangedAt: serverTimestamp(),
      });

      this.authService.applyLocalUserPatch({
        password: newPassword,
        passwordConfirmation: newPassword,
        passwordChanged: true,
        passwordChangeRequired: false,
      });

      return { success: true, message: 'Password changed successfully' };
    } catch {
      return { success: false, message: 'Failed to change password' };
    }
  }

  /**
   * Change password from Settings using current password (reauth).
   * This updates Firebase Auth (login credential) + mirrors the value in Registerd.
   */
  async changePasswordFromSettings(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser?.uid) {
        return { success: false, message: 'User not authenticated' };
      }

      const firebaseUser = this.auth.currentUser;
      if (!firebaseUser?.email) {
        return { success: false, message: 'Please log out and log back in, then try again.' };
      }

      try {
        const cred = EmailAuthProvider.credential(firebaseUser.email, input.currentPassword);
        await reauthenticateWithCredential(firebaseUser, cred);
      } catch (e: any) {
        const code = String(e?.code || '');
        if (code.includes('auth/wrong-password') || code.includes('auth/invalid-credential')) {
          return { success: false, message: 'Current password is incorrect.' };
        }
        return { success: false, message: 'Unable to verify your current password. Please try again.' };
      }

      try {
        await updatePassword(firebaseUser, input.newPassword);
      } catch (e: any) {
        const code = String(e?.code || '');
        if (code.includes('auth/weak-password')) {
          return { success: false, message: 'Password is too weak. Please choose a stronger password.' };
        }
        if (code.includes('auth/requires-recent-login')) {
          return { success: false, message: 'Please log out and log back in, then try again.' };
        }
        return { success: false, message: 'Failed to update password. Please try again.' };
      }

      const userDocRef = doc(this.firestore, 'Registerd', currentUser.uid);
      await updateDoc(userDocRef, {
        password: input.newPassword,
        passwordConfirmation: input.newPassword,
        passwordChanged: true,
        passwordChangeRequired: false,
        passwordChangedAt: serverTimestamp()
      });

      this.authService.applyLocalUserPatch({
        password: input.newPassword,
        passwordConfirmation: input.newPassword,
        passwordChanged: true,
        passwordChangeRequired: false,
      });

      return { success: true, message: 'Password changed successfully' };
    } catch {
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
      return false;
    }
  }
}
