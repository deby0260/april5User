import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, UserData } from '../services/auth';
import { AlertController, ToastController } from '@ionic/angular';
import { Firestore, doc, setDoc } from '@angular/fire/firestore';

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
    private toastController: ToastController
  ) { }

  ngOnInit() {
    
    this.currentUser = this.authService.getCurrentUser();

    
    this.loadSettings();
  }

  loadSettings() {
    
    const savedSettings = localStorage.getItem('fetchsafe-settings');
    if (savedSettings) {
      this.settings = { ...this.settings, ...JSON.parse(savedSettings) };
    }
  }

  saveSettings() {
    
    localStorage.setItem('fetchsafe-settings', JSON.stringify(this.settings));
    void this.syncEmailNotificationPreferenceToProfile();
    this.showToast('Settings saved successfully');
  }

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
      console.warn('Could not sync email notification preference to profile', e);
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
    const alert = await this.alertController.create({
      header: 'Change Password',
      message: 'This feature will be available soon. For now, you can reset your password from the login screen.',
      buttons: ['OK']
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
              console.error('Logout error:', error);
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
          handler: () => {
            localStorage.clear();
            this.settings = {
              appNotifications: true,
              smsNotifications: false,
              emailNotifications: false,
              darkMode: false,
              language: 'English'
            };
            this.showToast('App data cleared');
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
