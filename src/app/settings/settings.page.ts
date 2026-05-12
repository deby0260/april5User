import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { AuthService, UserData } from '../services/auth';
import { AlertController, ToastController } from '@ionic/angular';
import { Firestore, doc, getDoc, setDoc } from '@angular/fire/firestore';
import { NotificationService } from '../services/notification.service';
import { PasswordChangeService } from '../services/password-change.service';

interface AppSettings {
  appNotifications: boolean;
  smsNotifications: boolean;
  emailNotifications: boolean;
  darkMode: boolean;
  language: string;
}

@Component({
  selector: 'app-settings',
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
  standalone: false
})
export class SettingsPage implements OnInit {
  settings: AppSettings = {
    appNotifications: true,
    smsNotifications: false,
    emailNotifications: false,
    darkMode: false,
    language: 'English'
  };

  currentUser: UserData | null = null;

  constructor(
    private router: Router,
    private authService: AuthService,
    private firestore: Firestore,
    private alertController: AlertController,
    private toastController: ToastController,
    private notificationService: NotificationService,
    private passwordChangeService: PasswordChangeService
  ) { }

  async ngOnInit() {
    this.currentUser = this.authService.getCurrentUser();
    this.loadSettings();
    await this.mergeEmailPreferenceFromProfile();
    await this.mergeSmsPreferenceFromProfile();
  }

  /** Reconcile native listeners if the user changed settings in another session or before login. */
  async ionViewWillEnter() {
    this.loadSettings();
    await this.mergeEmailPreferenceFromProfile();
    await this.mergeSmsPreferenceFromProfile();
    await this.notificationService.syncAppNotificationPreference(this.settings.appNotifications);
  }

  loadSettings() {
    
    const savedSettings = localStorage.getItem('fetchsafe-settings');
    if (savedSettings) {
      this.settings = { ...this.settings, ...JSON.parse(savedSettings) };
    }
  }

  async saveSettings() {
    localStorage.setItem('fetchsafe-settings', JSON.stringify(this.settings));
    await this.syncEmailNotificationPreferenceToProfile();
    await this.syncSmsNotificationPreferenceToProfile();
    await this.notificationService.syncAppNotificationPreference(this.settings.appNotifications);
    if (!this.settings.appNotifications) {
      await this.showToast('App notifications disabled on this device');
    } else if (!Capacitor.isNativePlatform()) {
      await this.showToast(
        'Settings saved. Install the FetchSafe app on iOS or Android for lock-screen pickup alerts.'
      );
    } else {
      await this.showToast('Settings saved successfully');
    }
  }

  /** Aligns with Cloud Function `sendNotificationDigestEmails` (skips when false in Registerd). */
  private async syncEmailNotificationPreferenceToProfile() {
    const u = this.currentUser;
    if (!u?.uid) {
      return;
    }
    try {
      await setDoc(
        doc(this.firestore, 'Registerd', u.uid),
        { emailNotifications: this.settings.emailNotifications },
        { merge: true }
      );
    } catch (e) {
      console.error('syncEmailNotificationPreferenceToProfile', e);
    }
  }

  /** Aligns with Cloud Function `sendSmsOnNotificationCreate` (only sends when true in Registerd). */
  private async syncSmsNotificationPreferenceToProfile() {
    const u = this.currentUser;
    if (!u?.uid) {
      return;
    }
    try {
      await setDoc(
        doc(this.firestore, 'Registerd', u.uid),
        { smsNotifications: this.settings.smsNotifications },
        { merge: true }
      );
    } catch (e) {
      console.error('syncSmsNotificationPreferenceToProfile', e);
    }
  }

  private async mergeEmailPreferenceFromProfile() {
    const uid = this.currentUser?.uid;
    if (!uid) {
      return;
    }
    try {
      const snap = await getDoc(doc(this.firestore, 'Registerd', uid));
      if (!snap.exists()) {
        return;
      }
      const v = snap.get('emailNotifications');
      if (typeof v === 'boolean') {
        this.settings.emailNotifications = v;
        localStorage.setItem('fetchsafe-settings', JSON.stringify(this.settings));
      }
    } catch (e) {
      console.error('mergeEmailPreferenceFromProfile', e);
    }
  }

  private async mergeSmsPreferenceFromProfile() {
    const uid = this.currentUser?.uid;
    if (!uid) {
      return;
    }
    try {
      const snap = await getDoc(doc(this.firestore, 'Registerd', uid));
      if (!snap.exists()) {
        return;
      }
      const v = snap.get('smsNotifications');
      if (typeof v === 'boolean') {
        this.settings.smsNotifications = v;
        localStorage.setItem('fetchsafe-settings', JSON.stringify(this.settings));
      }
    } catch (e) {
      console.error('mergeSmsPreferenceFromProfile', e);
    }
  }

  async toggleDarkMode() {
    this.saveSettings();
    
    document.body.classList.toggle('dark', this.settings.darkMode);
    await this.showToast(`Dark mode ${this.settings.darkMode ? 'enabled' : 'disabled'}`);
  }

  async changeLanguage() {
    const alert = await this.alertController.create({
      header: 'Select Language',
      inputs: [
        {
          name: 'english',
          type: 'radio',
          label: 'English',
          value: 'English',
          checked: this.settings.language === 'English'
        },
        {
          name: 'spanish',
          type: 'radio',
          label: 'Español',
          value: 'Español',
          checked: this.settings.language === 'Español'
        },
        {
          name: 'french',
          type: 'radio',
          label: 'Français',
          value: 'Français',
          checked: this.settings.language === 'Français'
        }
      ],
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'OK',
          handler: (data) => {
            if (data) {
              this.settings.language = data;
              this.saveSettings();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  editProfile() {
    
    this.showToast('Edit profile feature coming soon');
  }

  editPrivacy() {
    
    this.showToast('Privacy settings feature coming soon');
  }

  async changePassword() {
    const u = this.authService.getCurrentUser();
    if (!u?.uid) {
      await this.showToast('Please log in first.');
      return;
    }

    const alert = await this.alertController.create({
      header: 'Change Password',
      message: 'Enter your current password to confirm, then set a new password.',
      inputs: [
        {
          name: 'currentPassword',
          type: 'password',
          placeholder: 'Current password',
        },
        {
          name: 'newPassword',
          type: 'password',
          placeholder: 'New password (min 6 characters)',
        },
        {
          name: 'confirmPassword',
          type: 'password',
          placeholder: 'Confirm new password',
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Update',
          handler: async (data) => {
            const currentPassword = String(data?.currentPassword || '');
            const newPassword = String(data?.newPassword || '');
            const confirmPassword = String(data?.confirmPassword || '');

            if (!currentPassword || !newPassword || !confirmPassword) {
              await this.showToast('Please fill in all fields.');
              return false;
            }
            if (newPassword.length < 6) {
              await this.showToast('New password must be at least 6 characters.');
              return false;
            }
            if (newPassword !== confirmPassword) {
              await this.showToast('New passwords do not match.');
              return false;
            }

            const result = await this.passwordChangeService.changePasswordFromSettings({
              currentPassword,
              newPassword,
            });
            if (!result.success) {
              await this.showToast(result.message);
              return false;
            }

            // Refresh local reference for UI (AuthService storage already updated by service).
            this.currentUser = this.authService.getCurrentUser();
            await this.showToast('Password updated successfully.');
            return true;
          }
        }
      ]
    });
    await alert.present();
  }

  async logout() {
    const alert = await this.alertController.create({
      header: 'Logout',
      message: 'Are you sure you want to logout?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Logout',
          handler: async () => {
            try {
              await this.authService.logout();
              await this.showToast('Logged out successfully');
              this.router.navigate(['/home-screen']);
            } catch (error) {
              await this.showToast('Error logging out. Please try again.');
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async clearData() {
    const alert = await this.alertController.create({
      header: 'Clear App Data',
      message: 'This will clear all app settings and cache. Are you sure?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Clear',
          handler: async () => {
            localStorage.clear();
            this.settings = {
              appNotifications: true,
              smsNotifications: false,
              emailNotifications: false,
              darkMode: false,
              language: 'English'
            };
            localStorage.setItem('fetchsafe-settings', JSON.stringify(this.settings));
            this.currentUser = this.authService.getCurrentUser();
            if (this.currentUser?.uid) {
              try {
                await setDoc(
                  doc(this.firestore, 'Registerd', this.currentUser.uid),
                  {
                    smsNotifications: false,
                    emailNotifications: false,
                  },
                  { merge: true }
                );
              } catch (e) {
                console.error('clearData Registerd sync', e);
              }
            }
            await this.showToast('App data cleared');
          }
        }
      ]
    });
    await alert.present();
  }

  private async showToast(message: string) {
    const toast = await this.toastController.create({
      message: message,
      duration: 2000,
      position: 'bottom'
    });
    await toast.present();
  }
}
