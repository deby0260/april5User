import { Injectable } from '@angular/core';
import { Firestore, collection, addDoc } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { Auth } from '@angular/fire/auth';
import { onAuthStateChanged, User } from 'firebase/auth';
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
  constructor(
    private firestore: Firestore,
    private functions: Functions,
    private auth: Auth
  ) {}

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
   * Sends one email per new notification: either Firestore `mail` docs (Trigger Email extension)
   * or HTTPS callable that uses Resend on the server.
   */
  async forwardNewNotifications(
    items: EmailableNotificationItem[],
    userEmail: string | undefined | null
  ): Promise<void> {
    if (!this.isEmailForwardingEnabled() || !userEmail?.trim()) {
      return;
    }

    const maxPerSync = environment.maxNotificationEmailsPerSync ?? 30;

    const sentIds = this.loadSentIds();
    const pending = items.filter((n) => n.id && !sentIds.has(n.id));
    if (pending.length === 0) {
      return;
    }

    const batch = pending.slice(0, maxPerSync);

    if (environment.notificationEmailMode === 'vercel_http') {
      const base = this.normalizeVercelBaseUrl(environment.notificationEmailVercelBaseUrl);
      if (!base) {
        console.warn('notificationEmailVercelBaseUrl is not set; skipping email forward');
        return;
      }
      await this.forwardViaVercel(base, batch, sentIds);
      return;
    }

    if (environment.notificationEmailMode === 'resend_callable') {
      await this.forwardViaResendCallable(batch, sentIds);
      return;
    }

    const collectionName = environment.notificationEmailCollection ?? 'mail';
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

  /** Accepts `https://host` or `host` (https prepended). No trailing slash. */
  private normalizeVercelBaseUrl(raw: string | undefined): string {
    const t = (raw ?? '').trim().replace(/\/$/, '');
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    return `https://${t}`;
  }

  private async forwardViaVercel(
    baseUrl: string,
    batch: EmailableNotificationItem[],
    sentIds: Set<string>
  ): Promise<void> {
    try {
      const user = await this.getFirebaseAuthUser();
      if (!user) {
        console.warn('No Firebase session; cannot call Vercel email API');
        return;
      }
      const token = await user.getIdToken();
      const url = `${baseUrl.replace(/\/$/, '')}/api/send-notification-digest`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: batch.map((n) => ({
            id: n.id,
            title: n.title,
            displayMessage: n.displayMessage,
            time: n.time,
          })),
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        console.warn('Vercel notification email failed:', response.status, text);
        return;
      }
      const data = (await response.json()) as { emailedIds?: string[] };
      const emailedIds = Array.isArray(data?.emailedIds) ? data.emailedIds : [];
      for (const id of emailedIds) {
        if (id) {
          sentIds.add(id);
        }
      }
      this.persistSentIds(sentIds);
    } catch (e) {
      console.warn('Vercel notification email request failed:', e);
    }
  }

  /** First auth emission after persistence restore (authStateReady not in this firebase/auth build). */
  private getFirebaseAuthUser(): Promise<User | null> {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(this.auth, (u) => {
        unsub();
        resolve(u);
      });
    });
  }

  private async forwardViaResendCallable(
    batch: EmailableNotificationItem[],
    sentIds: Set<string>
  ): Promise<void> {
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
      console.warn('Notification email via Resend callable failed (deploy functions + set resend config):', e);
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

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
