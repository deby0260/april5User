import { Injectable } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';

@Injectable({
  providedIn: 'root',
})
export class PasswordResetService {
  constructor(private functions: Functions) {}

  /** URL Firebase redirects to after the user opens the email link. */
  getResetPasswordContinueUrl(): string {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}/reset-password`;
    }
    return 'https://fetchsafe2.firebaseapp.com/reset-password';
  }

  /**
   * Sends a password reset email from fetchsafe.notification@gmail.com via Cloud Function.
   */
  async requestPasswordReset(email: string): Promise<{ success: boolean; message: string }> {
    const trimmed = email.trim();
    if (!trimmed) {
      return { success: false, message: 'Email is required.' };
    }

    try {
      const fn = httpsCallable<
        { email: string; continueUrl: string },
        { success?: boolean }
      >(this.functions, 'requestPasswordReset');
      await fn({
        email: trimmed,
        continueUrl: this.getResetPasswordContinueUrl(),
      });
      return { success: true, message: 'Reset link sent.' };
    } catch (error: unknown) {
      return {
        success: false,
        message: this.mapCallableError(error),
      };
    }
  }

  private mapCallableError(error: unknown): string {
    const err = error as { code?: string; message?: string; details?: unknown };
    const code = err?.code ?? '';
    const message = (err?.message ?? '').replace(/^Firebase:\s*/i, '').trim();

    if (
      message.includes('CORS') ||
      message.includes('Failed to fetch') ||
      message.includes('ERR_FAILED')
    ) {
      return 'Cannot reach the password reset service. Deploy the Cloud Function requestPasswordReset, then try again.';
    }
    if (code === 'functions/not-found') {
      return 'No account found with this email address. Please check your email or create a new account.';
    }
    if (code === 'functions/invalid-argument') {
      return message || 'Please enter a valid email address.';
    }
    if (code === 'functions/failed-precondition') {
      return message || 'Unable to send reset email. Please contact the administrator.';
    }
    if (code === 'functions/resource-exhausted') {
      return 'Too many requests. Please try again later.';
    }
    if (code === 'functions/unavailable' || code === 'functions/deadline-exceeded') {
      return 'Network error. Please check your connection and try again.';
    }
    if (code === 'functions/internal') {
      return message || 'Failed to send reset email. Please try again later.';
    }
    return message || 'Failed to send reset link. Please try again.';
  }
}
