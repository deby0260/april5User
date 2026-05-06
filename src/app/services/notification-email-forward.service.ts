import { Injectable } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { environment } from '../../environments/environment';

const SETTINGS_KEY = 'fetchsafe-settings';
const SENT_IDS_KEY = 'fetchsafe-emailed-notification-ids';
const MAX_STORED_IDS = 800;

export interface EmailableNotificationItem {
  id: string;
  title: string;
  displayMessage: string;
  time: string;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationEmailForwardService {
  constructor(private functions: Functions) {}

  isEmailForwardingEnabled(): boolean {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return false;
      }
      const parsed = JSON.parse(raw) as { emailNotifications?: boolean };
      return parsed.emailNotifications === true;
    } catch {
      return false;
    }
  }

  /**
   * Sends one email per new notification via HTTPS callable `sendNotificationDigestEmails`
   * (Resend on the server; API key never in the app).
   */
  async forwardNewNotifications(items: EmailableNotificationItem[]): Promise<void> {
    if (environment.notificationEmailMode !== 'resend_callable') {
      return;
    }
    if (!this.isEmailForwardingEnabled()) {
      return;
    }

    const maxPerSync = environment.maxNotificationEmailsPerSync ?? 30;

    const sentIds = this.loadSentIds();
    const pending = items.filter((n) => n.id && !sentIds.has(n.id));
    if (pending.length === 0) {
      return;
    }

    const batch = pending.slice(0, maxPerSync);

    try {
      const fn = httpsCallable(this.functions, 'sendNotificationDigestEmails');
      const res = await fn({
        items: batch.map((n) => ({
          id: n.id,
          title: n.title,
          displayMessage: n.displayMessage,
          time: n.time,
        })),
      });
      const data = res.data as { emailedIds?: string[] };
      const emailedIds = Array.isArray(data?.emailedIds) ? data.emailedIds : [];
      for (const id of emailedIds) {
        if (id) {
          sentIds.add(id);
        }
      }
      this.persistSentIds(sentIds);
    } catch (e) {
    }
  }

  private loadSentIds(): Set<string> {
    try {
      const raw = localStorage.getItem(SENT_IDS_KEY);
      if (!raw) {
        return new Set();
      }
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  private persistSentIds(ids: Set<string>): void {
    const arr = [...ids];
    const trimmed = arr.length > MAX_STORED_IDS ? arr.slice(arr.length - MAX_STORED_IDS) : arr;
    localStorage.setItem(SENT_IDS_KEY, JSON.stringify(trimmed));
  }
}
