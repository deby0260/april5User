import { Injectable } from '@angular/core';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';
import { AuthService } from './auth';

const SETTINGS_KEY = 'fetchsafe-settings';

export interface NotificationChannelPrefs {
  appNotifications: boolean;
  smsNotifications: boolean;
  emailNotifications: boolean;
}

/**
 * Keeps local notification toggles aligned with `Registerd` (used by Cloud Functions
 * for SMS/email) and exposes a single read API for the client.
 */
@Injectable({ providedIn: 'root' })
export class NotificationPreferencesService {
  constructor(
    private firestore: Firestore,
    private authService: AuthService
  ) {}

  readLocal(): NotificationChannelPrefs {
    const defaults: NotificationChannelPrefs = {
      appNotifications: true,
      smsNotifications: false,
      emailNotifications: false,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return defaults;
      }
      const parsed = JSON.parse(raw) as Partial<NotificationChannelPrefs>;
      return {
        appNotifications: parsed.appNotifications !== false,
        smsNotifications: parsed.smsNotifications === true,
        emailNotifications: parsed.emailNotifications === true,
      };
    } catch {
      return defaults;
    }
  }

  /** Merge Firestore `Registerd` email/SMS flags into local settings (Settings page + background). */
  async syncFromFirestore(): Promise<NotificationChannelPrefs> {
    const prefs = this.readLocal();
    const uid = this.authService.getCurrentUser()?.uid;
    if (!uid) {
      return prefs;
    }
    try {
      const snap = await getDoc(doc(this.firestore, 'Registerd', uid));
      if (!snap.exists()) {
        return prefs;
      }
      const email = snap.get('emailNotifications');
      const sms = snap.get('smsNotifications');
      if (typeof email === 'boolean') {
        prefs.emailNotifications = email;
      }
      if (typeof sms === 'boolean') {
        prefs.smsNotifications = sms;
      }
      let stored: Record<string, unknown> = {};
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          stored = JSON.parse(raw) as Record<string, unknown>;
        }
      } catch {
        /* noop */
      }
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          ...stored,
          emailNotifications: prefs.emailNotifications,
          smsNotifications: prefs.smsNotifications,
        })
      );
    } catch {
      /* noop */
    }
    return this.readLocal();
  }

  isAppNotificationsEnabled(): boolean {
    return this.readLocal().appNotifications;
  }

  isEmailNotificationsEnabled(): boolean {
    return this.readLocal().emailNotifications;
  }

  isSmsNotificationsEnabled(): boolean {
    return this.readLocal().smsNotifications;
  }
}
