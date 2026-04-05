import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc, query, where, getDocs, doc, getDoc, setDoc } from '@angular/fire/firestore';
import { Auth as FirebaseAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, User } from '@angular/fire/auth';
import { BehaviorSubject, Observable } from 'rxjs';

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
    private auth: FirebaseAuth
  ) {
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
        uid: uid
      };

      // Use setDoc with doc() to create a document with UID as the document ID
      const userDocRef = doc(this.firestore, 'Registerd', uid);
      await setDoc(userDocRef, userDataWithUid);


      await signOut(this.auth);


      localStorage.removeItem('currentUser');
      this.currentUserSubject.next(null);

      return {
        success: true,
        message: 'User registered successfully',
        uid: uid
      };
    } catch (error: any) {
      console.error('Registration error:', error);
      return {
        success: false,
        message: error.message || 'Registration failed'
      };
    }
  }

  async loginUser(email: string, password: string): Promise<{ success: boolean; message: string; user?: UserData }> {
    try {
      // First, try to authenticate with Firebase
      console.log('Attempting Firebase authentication for:', email);
      try {
        const userCredential = await signInWithEmailAndPassword(this.auth, email, password);
        const uid = userCredential.user.uid;
        console.log('Firebase authentication successful. UID:', uid);

        // Now get the user document directly using the UID as document ID
        const userDocRef = doc(this.firestore, 'Registerd', uid);
        const userDocSnap = await getDoc(userDocRef);

        if (!userDocSnap.exists()) {
          console.warn('User UID not found in Registered collection:', uid);
          return {
            success: false,
            message: 'User data not found in database'
          };
        }

        const userData = userDocSnap.data() as UserData;
        console.log('User data retrieved from Firestore:', userData.email);

        // Verify email matches
        if (userData.email !== email) {
          console.warn('Email mismatch. Expected:', email, 'Got:', userData.email);
          return {
            success: false,
            message: 'Email mismatch in user data'
          };
        }

        // Store user data in localStorage and BehaviorSubject
        localStorage.setItem('currentUser', JSON.stringify(userData));
        this.currentUserSubject.next(userData);

        console.log('Login successful for:', email);
        
        // Check if this is a verified parent who needs to change password
        await this.checkAndNotifyVerifiedParent(userData);

        return {
          success: true,
          message: 'Login successful',
          user: userData
        };
      } catch (firebaseError: any) {
        // If Firebase Auth fails, try Firestore-only login as fallback
        console.warn('Firebase authentication failed, trying Firestore fallback:', firebaseError.code);
        if (firebaseError.code === 'auth/invalid-credential' || firebaseError.code === 'auth/user-not-found') {
          console.log('User not in Firebase Auth, checking Firestore directly...');
          return await this.loginWithFirestoreOnly(email, password);
        }
        throw firebaseError;
      }
    } catch (error: any) {
      console.error('Login error:', error);
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
      await signOut(this.auth);
      localStorage.removeItem('currentUser');
      this.currentUserSubject.next(null);
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  getCurrentUser(): UserData | null {
    return this.currentUserSubject.value;
  }

  isLoggedIn(): boolean {
    return this.currentUserSubject.value !== null;
  }

  private loadCurrentUser(): void {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser) as UserData;
        this.currentUserSubject.next(userData);
      } catch (error) {
        console.error('Error loading saved user:', error);
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
        console.log('User has already changed password');
        return;
      }

      // Check if user is a parent or has a family
      if (!userData['familyName'] && !userData['familyRole']) {
        console.log('User is not part of a family');
        return;
      }

      // Check if password change is already required
      if (userData['passwordChangeRequired'] === true) {
        console.log('Password change already required for this user');
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
        console.log('No family records found for user');
        return;
      }

      // Check if user is verified
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const isVerified = data['verified At'] || data['verifiedAt'] || data['verified'];
        const familyName = data['Family Name'] || data['familyName'];

        if (isVerified) {
          console.log('Parent is verified, creating password change notification');
          
          // Create password change notification
          await this.createPasswordChangeNotification(userData, familyName, isVerified);
          break;
        }
      }
    } catch (error) {
      console.error('Error checking parent verification status:', error);
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
        console.log('Password change notification already exists for this user');
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

      console.log('Password change notification created for verified parent');
    } catch (error) {
      console.error('Error creating password change notification:', error);
    }
  }


  async loginWithFirestoreOnly(email: string, password: string): Promise<{ success: boolean; message: string; user?: UserData }> {
    try {
      console.log('Attempting Firestore-only login for:', email);

      // First, find user by email
      const registerdCollection = collection(this.firestore, 'Registerd');
      const q = query(registerdCollection, where('email', '==', email));
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        console.warn('User not found in Firestore:', email);
        return {
          success: false,
          message: 'Invalid email or password'
        };
      }

      const userDoc = querySnapshot.docs[0];
      const userData = userDoc.data() as UserData;

      console.log('User found in Firestore:', userData.email);

      // Verify password matches (plain text comparison for Firestore-only users)
      if (userData.password !== password) {
        console.warn('Password mismatch for user:', email);
        return {
          success: false,
          message: 'Invalid email or password'
        };
      }

      console.log('Password verified for:', email);

      // Store user data in localStorage and BehaviorSubject
      localStorage.setItem('currentUser', JSON.stringify(userData));
      this.currentUserSubject.next(userData);

      console.log('Firestore-only login successful for:', email);

      // Check if this is a verified parent who needs to change password
      await this.checkAndNotifyVerifiedParent(userData);

      return {
        success: true,
        message: 'Login successful',
        user: userData
      };
    } catch (error: any) {
      console.error('Firestore login error:', error);
      return {
        success: false,
        message: error.message || 'Login failed'
      };
    }
  }
}
