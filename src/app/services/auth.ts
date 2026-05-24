import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc, query, where, getDocs, doc, getDoc, setDoc, serverTimestamp } from '@angular/fire/firestore';
import {
  Auth as FirebaseAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  User,
  onAuthStateChanged,
} from '@angular/fire/auth';
import { BehaviorSubject, Observable } from 'rxjs';
import { OfflineCacheService } from './offline-cache.service';

export interface UserData {
  uid: string;
  contactNumber: string;
  email: string;
  fullName: string;
  password: string;
  passwordConfirmation: string;
  profilePicture?: string;
  familyName?: string;
  familyRole?: string;
  passwordChanged?: boolean;
  passwordChangeRequired?: boolean;
  passwordChangedAt?: any;
  passwordChangeCreatedAt?: any;
  createdAt?: any;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private currentUserSubject = new BehaviorSubject<UserData | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(
    private firestore: Firestore,
    private auth: FirebaseAuth,
    private offlineCache: OfflineCacheService
  ) {
    this.loadCurrentUser();
    this.watchFirebaseAuthPersistence();
  }

  /** Re-read saved session (e.g. cold start after force-close). */
  ensureSessionRestored(): void {
    if (this.currentUserSubject.value) {
      return;
    }
    this.loadCurrentUser();
  }

  /**
   * Firebase Auth may restore after localStorage; Firestore-only logins keep localStorage only.
   * Never clear a saved session just because Firebase has no user.
   */
  private watchFirebaseAuthPersistence(): void {
    onAuthStateChanged(this.auth, (firebaseUser) => {
      if (firebaseUser) {
        void this.syncSessionFromFirebaseUser(firebaseUser);
      }
    });
  }

  private async syncSessionFromFirebaseUser(firebaseUser: User): Promise<void> {
    if (this.currentUserSubject.value?.uid === firebaseUser.uid) {
      return;
    }
    try {
      const userDocRef = doc(this.firestore, 'Registerd', firebaseUser.uid);
      const userDocSnap = await getDoc(userDocRef);
      if (!userDocSnap.exists()) {
        return;
      }
      const userData: UserData = {
        ...(userDocSnap.data() as UserData),
        uid: firebaseUser.uid,
      };
      localStorage.setItem('currentUser', JSON.stringify(userData));
      const display = this.offlineCache.resolveUserProfileForDisplay(userData) || userData;
      this.currentUserSubject.next(display);
      void this.offlineCache.cacheUserProfilePicture(userData.uid, userData.profilePicture);
    } catch {
      /* keep existing local session */
    }
  }

  private getFriendlyAuthErrorMessage(error: any, fallback: string): string {
    const code: string | undefined = error?.code;
    if (code) {
      switch (code) {
        case 'auth/email-already-in-use':
          return 'That email is already in use. Please use a different email.';
        case 'auth/invalid-email':
          return 'Please enter a valid email address.';
        case 'auth/weak-password':
          return 'Password is too weak. Please choose a stronger password.';
        case 'auth/network-request-failed':
          return 'Network error. Please check your connection and try again.';
        default:
          return fallback;
      }
    }

    const rawMessage = (error?.message ?? '').toString();
    const cleaned = rawMessage.replace(/^Firebase:\s*/i, '').trim();
    return cleaned ? cleaned : fallback;
  }

  async registerUser(userData: Omit<UserData, 'uid'>): Promise<{ success: boolean; message: string; uid?: string }> {
    try {

      const userCredential = await createUserWithEmailAndPassword(
        this.auth,
        userData.email,
        userData.password
      );

      const uid = userCredential.user.uid;


      const userDataWithUid: UserData = {
        ...userData,
        uid: uid,
        // Snapshot join time so new users don't see past announcements.
        createdAt: (userData as any)?.createdAt ?? serverTimestamp(),
      };

      // Use setDoc with doc() to create a document with UID as the document ID
      const userDocRef = doc(this.firestore, 'Registerd', uid);
      await setDoc(userDocRef, userDataWithUid);
      await this.syncDeviceTimeZoneToProfile(uid);

      await signOut(this.auth);


      localStorage.removeItem('currentUser');
      this.currentUserSubject.next(null);

      return {
        success: true,
        message: 'User registered successfully',
        uid: uid
      };
    } catch (error: any) {
      return {
        success: false,
        message: this.getFriendlyAuthErrorMessage(error, 'Registration failed. Please try again.')
      };
    }
  }

  async loginUser(email: string, password: string): Promise<{ success: boolean; message: string; user?: UserData }> {
    try {
      // First, try to authenticate with Firebase
      try {
        const userCredential = await signInWithEmailAndPassword(this.auth, email, password);
        const uid = userCredential.user.uid;

        // Now get the user document directly using the UID as document ID
        const userDocRef = doc(this.firestore, 'Registerd', uid);
        const userDocSnap = await getDoc(userDocRef);

        if (!userDocSnap.exists()) {
          return {
            success: false,
            message: 'User data not found in database'
          };
        }

        const userData = userDocSnap.data() as UserData;

        // Backfill createdAt when missing (keeps old users stable, helps new users filter announcements).
        if (!userData?.createdAt) {
          const ct = userCredential.user?.metadata?.creationTime;
          const parsed = ct ? new Date(ct) : null;
          if (parsed && !Number.isNaN(parsed.getTime())) {
            userData.createdAt = parsed;
            try {
              await setDoc(userDocRef, { createdAt: parsed }, { merge: true });
            } catch {
              // noop
            }
          }
        }

        // Verify email matches
        if (userData.email !== email) {
          return {
            success: false,
            message: 'Email mismatch in user data'
          };
        }

        // Store user data in localStorage and BehaviorSubject
        localStorage.setItem('currentUser', JSON.stringify(userData));
        this.currentUserSubject.next(userData);
        void this.syncDeviceTimeZoneToProfile(uid);
        void this.offlineCache.cacheUserProfilePicture(uid, userData.profilePicture);

        // Check if this is a verified parent who needs to change password
        await this.checkAndNotifyVerifiedParent(userData);

        return {
          success: true,
          message: 'Login successful',
          user: this.offlineCache.resolveUserProfileForDisplay(userData) || userData
        };
      } catch (firebaseError: any) {
        // If Firebase Auth fails, try Firestore-only login as fallback
        if (firebaseError.code === 'auth/invalid-credential' || firebaseError.code === 'auth/user-not-found') {
          return await this.loginWithFirestoreOnly(email, password);
        }
        throw firebaseError;
      }
    } catch (error: any) {
      const errorMessage = error.code === 'auth/invalid-credential'
        ? 'Invalid email or password'
        : error.message || 'Login failed';
      return {
        success: false,
        message: errorMessage
      };
    }
  }

  async logout(): Promise<void> {
    try {
      const uid = this.currentUserSubject.value?.uid;
      await signOut(this.auth);
      localStorage.removeItem('currentUser');
      if (uid) {
        localStorage.removeItem(`userRole:${uid}`);
      }
      this.currentUserSubject.next(null);
    } catch (error) {
    }
  }

  getCurrentUser(): UserData | null {
    const user = this.currentUserSubject.value;
    return this.offlineCache.resolveUserProfileForDisplay(user);
  }

  /** Updates in-memory session + localStorage (e.g. after password change). */
  applyLocalUserPatch(patch: Partial<UserData>): void {
    const user = this.getCurrentUser();
    if (!user?.uid) {
      return;
    }
    const merged: UserData = { ...user, ...patch, uid: user.uid };
    localStorage.setItem('currentUser', JSON.stringify(merged));
    const display = this.offlineCache.resolveUserProfileForDisplay(merged) || merged;
    this.currentUserSubject.next(display);
    if (patch.profilePicture) {
      void this.offlineCache.cacheUserProfilePicture(user.uid, patch.profilePicture);
    }
  }

  /** Merges latest Registerd fields into the active session (e.g. after settings edit). */
  async reloadCurrentUserFromFirestore(): Promise<UserData | null> {
    const user = this.getCurrentUser();
    if (!user?.uid) {
      return null;
    }
    try {
      const snap = await getDoc(doc(this.firestore, 'Registerd', user.uid));
      if (!snap.exists()) {
        return user;
      }
      const merged: UserData = { ...user, ...(snap.data() as UserData), uid: user.uid };
      localStorage.setItem('currentUser', JSON.stringify(merged));
      await this.offlineCache.cacheUserProfilePicture(merged.uid, merged.profilePicture);
      const display = this.offlineCache.resolveUserProfileForDisplay(merged) || merged;
      this.currentUserSubject.next(display);
      return display;
    } catch {
      return user;
    }
  }

  /** Updates Registerd profile fields and refreshes the in-app session. */
  async updateProfile(updates: {
    fullName?: string;
    contactNumber?: string;
    profilePicture?: string;
  }): Promise<{ success: boolean; message: string }> {
    const user = this.getCurrentUser();
    if (!user?.uid) {
      return { success: false, message: 'Please log in first.' };
    }

    const fullName = updates.fullName !== undefined ? updates.fullName.trim() : user.fullName;
    const contactNumber =
      updates.contactNumber !== undefined ? updates.contactNumber.trim() : user.contactNumber;

    if (!fullName) {
      return { success: false, message: 'Full name is required.' };
    }
    if (!contactNumber) {
      return { success: false, message: 'Contact number is required.' };
    }
    if (!/^\d{11}$/.test(contactNumber)) {
      return { success: false, message: 'Contact number must be exactly 11 digits.' };
    }

    if (!this.offlineCache.isOnline()) {
      return {
        success: false,
        message: 'You are offline. Connect to the internet to save profile changes.',
      };
    }

    try {
      const patch: Record<string, string> = { fullName, contactNumber };
      if (updates.profilePicture !== undefined) {
        patch['profilePicture'] = updates.profilePicture;
      }

      await setDoc(doc(this.firestore, 'Registerd', user.uid), patch, { merge: true });

      const merged: UserData = {
        ...user,
        fullName,
        contactNumber,
        ...(updates.profilePicture !== undefined
          ? { profilePicture: updates.profilePicture }
          : {}),
      };
      localStorage.setItem('currentUser', JSON.stringify(merged));
      this.currentUserSubject.next(merged);
      if (updates.profilePicture !== undefined) {
        await this.offlineCache.cacheUserProfilePicture(user.uid, updates.profilePicture);
      }
      return { success: true, message: 'Profile updated successfully.' };
    } catch {
      return { success: false, message: 'Failed to update profile. Please try again.' };
    }
  }

  /** Saves device IANA timezone so notification emails show local time (Cloud Functions). */
  async syncDeviceTimeZoneToProfile(uid?: string): Promise<void> {
    const id = uid ?? this.getCurrentUser()?.uid;
    if (!id) {
      return;
    }
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!timeZone?.trim()) {
        return;
      }
      await setDoc(
        doc(this.firestore, 'Registerd', id),
        { timeZone: timeZone.trim() },
        { merge: true }
      );
    } catch {
      // noop
    }
  }

  isLoggedIn(): boolean {
    return this.currentUserSubject.value !== null;
  }

  private loadCurrentUser(): void {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser) as UserData;
        const display = this.offlineCache.resolveUserProfileForDisplay(userData) || userData;
        this.currentUserSubject.next(display);
        void this.offlineCache.cacheUserProfilePicture(userData.uid, userData.profilePicture);
      } catch (error) {
        localStorage.removeItem('currentUser');
      }
    }
  }

  /**
   * Check if user is a verified parent and create password change notification if needed
   */
  private async checkAndNotifyVerifiedParent(userData: UserData): Promise<void> {
    try {
      // Check if user has already changed password
      if (userData['passwordChanged'] === true) {
        return;
      }

      // Check if user is a parent or has a family
      if (!userData['familyName'] && !userData['familyRole']) {
        return;
      }

      // Check if password change is already required
      if (userData['passwordChangeRequired'] === true) {
        return;
      }

      // Query the List Of Families to check verification status
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const q = query(
        familiesCollection,
        where('uid', '==', userData.uid)
      );

      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        return;
      }

      // Check if user is verified
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const isVerified = data['verified At'] || data['verifiedAt'] || data['verified'];
        const familyName = data['Family Name'] || data['familyName'];

        if (isVerified) {
          // Create password change notification
          await this.createPasswordChangeNotification(userData, familyName, isVerified);
          break;
        }
      }
    } catch (error) {
    }
  }

  /**
   * Create a password change notification for a verified parent
   */
  private async createPasswordChangeNotification(userData: UserData, familyName: string, verificationDate: any): Promise<void> {
    try {
      const notificationsCollection = collection(this.firestore, 'Notifications');
      
      // Check if there's already a pending password change notification
      const q = query(
        notificationsCollection,
        where('recipientId', '==', userData.uid),
        where('type', '==', 'password_change_required'),
        where('passwordChanged', '==', false)
      );

      const existingNotifications = await getDocs(q);
      if (!existingNotifications.empty) {
        return;
      }

      // Create the notification
      await addDoc(notificationsCollection, {
        type: 'password_change_required',
        title: 'Change Your Password',
        message: 'Your account has been verified by an admin. Please change your password to secure your account.',
        recipientId: userData.uid,
        senderId: 'admin',
        senderName: 'Administrator',
        familyName: familyName,
        isRead: false,
        createdAt: new Date(),
        passwordChanged: false
      });

      // Update user record to mark that password change is required
      const userDocRef = doc(this.firestore, 'Registerd', userData.uid);
      await setDoc(userDocRef, {
        passwordChangeRequired: true,
        passwordChangeCreatedAt: verificationDate
      }, { merge: true });
    } catch (error) {
    }
  }


  async loginWithFirestoreOnly(email: string, password: string): Promise<{ success: boolean; message: string; user?: UserData }> {
    try {
      // First, find user by email
      const registerdCollection = collection(this.firestore, 'Registerd');
      const q = query(registerdCollection, where('email', '==', email));
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        return {
          success: false,
          message: 'Invalid email or password'
        };
      }

      const userDoc = querySnapshot.docs[0];
      const userData = userDoc.data() as UserData;

      // Verify password matches (plain text comparison for Firestore-only users)
      if (userData.password !== password) {
        return {
          success: false,
          message: 'Invalid email or password'
        };
      }

      // Store user data in localStorage and BehaviorSubject
      localStorage.setItem('currentUser', JSON.stringify(userData));
      this.currentUserSubject.next(userData);
      void this.syncDeviceTimeZoneToProfile(userData.uid);

      // Check if this is a verified parent who needs to change password
      await this.checkAndNotifyVerifiedParent(userData);

      return {
        success: true,
        message: 'Login successful',
        user: userData
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Login failed'
      };
    }
  }
}
