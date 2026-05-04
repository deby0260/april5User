import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

const MAX_ITEMS = 30;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getAdminApp(): admin.app.App {
  if (!admin.apps.length) {
    const raw = process.env['FIREBASE_SERVICE_ACCOUNT_JSON'];
    if (!raw?.trim()) {
      throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
    }
    const cred = JSON.parse(raw) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(cred),
    });
  }
  return admin.app();
}

function setCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function sendOneResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend ${res.status}: ${errText}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env['RESEND_API_KEY']?.trim();
  const from = process.env['RESEND_FROM']?.trim();
  if (!apiKey || !from) {
    res.status(500).json({ error: 'Server missing RESEND_API_KEY or RESEND_FROM' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization Bearer token' });
    return;
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    res.status(401).json({ error: 'Empty token' });
    return;
  }

  try {
    const app = getAdminApp();
    const decoded = await admin.auth(app).verifyIdToken(idToken);
    const uid = decoded.uid;

    const regSnap = await admin.firestore(app).doc(`Registerd/${uid}`).get();
    if (regSnap.exists && regSnap.get('emailNotifications') === false) {
      res.status(200).json({ emailedIds: [] });
      return;
    }

    let to = decoded.email?.trim() ?? '';
    if (!to) {
      const user = await admin.auth(app).getUser(uid);
      to = user.email?.trim() ?? '';
    }
    if (!to) {
      res.status(400).json({ error: 'No email on this account' });
      return;
    }

    const rawItems = (req.body as { items?: unknown })?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(200).json({ emailedIds: [] });
      return;
    }

    const items = rawItems.slice(0, MAX_ITEMS).map((row: unknown) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r['id'] ?? ''),
        title: String(r['title'] ?? ''),
        displayMessage: String(r['displayMessage'] ?? ''),
        time: String(r['time'] ?? ''),
      };
    });

    const emailedIds: string[] = [];
    for (const n of items) {
      if (!n.id) continue;
      const subject = `FetchSafe: ${n.title}`;
      const text = `${n.time}\n\n${n.displayMessage}`;
      const html = `<p><strong>${escapeHtml(n.time)}</strong></p><p>${escapeHtml(n.displayMessage).replace(/\n/g, '<br/>')}</p>`;
      try {
        await sendOneResend(apiKey, from, to, subject, text, html);
        emailedIds.push(n.id);
      } catch (e) {
        console.error('Resend send failed', n.id, e);
      }
    }

    res.status(200).json({ emailedIds });
  } catch (e: unknown) {
    console.error('send-notification-digest error', e);
    const code = (e as { code?: string })?.code;
    if (typeof code === 'string' && code.startsWith('auth/')) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    const msg = e instanceof Error ? e.message : 'Internal error';
    res.status(500).json({ error: msg });
  }
}
