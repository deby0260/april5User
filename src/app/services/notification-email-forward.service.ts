import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc } from '@angular/fire/firestore';
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
  constructor(private firestore: Firestore) {}

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
   * Queues one email per notification (Firebase Extension: Trigger Email from Firestore).
   * Collection defaults to `mail`. Ensure Firestore rules allow creates and the extension is installed.
   */
  async forwardNewNotifications(
    items: EmailableNotificationItem[],
    userEmail: string | undefined | null
  ): Promise<void> {
    if (!this.isEmailForwardingEnabled() || !userEmail?.trim()) {
      return;
    }

    const collectionName = environment.notificationEmailCollection ?? 'mail';
    const maxPerSync = environment.maxNotificationEmailsPerSync ?? 30;

    const sentIds = this.loadSentIds();
    const pending = items.filter((n) => n.id && !sentIds.has(n.id));
    if (pending.length === 0) {
      return;
    }

    const batch = pending.slice(0, maxPerSync);
    const mailCol = collection(this.firestore, collectionName);

    for (const n of batch) {
      const text = `${n.time}\n\n${n.displayMessage}`;
      const html = `<p><strong>${this.escapeHtml(n.time)}</strong></p><p>${this.escapeHtml(n.displayMessage).replace(/\n/g, '<br/>')}</p>`;
      try {
        await addDoc(mailCol, {
          to: userEmail.trim(),
          message: {
            subject: `FetchSafe: ${n.title}`,
            text,
            html,
          },
        });
        sentIds.add(n.id);
      } catch (e) {
        console.warn('Notification email queue failed (check Firestore rules / Trigger Email extension):', e);
      }
    }

    this.persistSentIds(sentIds);
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

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
