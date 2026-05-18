import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Auth,
  confirmPasswordReset,
  signInWithEmailAndPassword,
  signOut,
  verifyPasswordResetCode,
} from '@angular/fire/auth';
import { Firestore, doc, setDoc } from '@angular/fire/firestore';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-reset-password',
  templateUrl: './reset-password.page.html',
  styleUrls: ['./reset-password.page.scss'],
  standalone: false,
})
export class ResetPasswordPage implements OnInit, OnDestroy {
  oobCode = '';
  email = '';
  newPassword = '';
  confirmPassword = '';
  showPassword = false;
  showConfirmPassword = false;

  codeValid = false;
  codeError = '';
  formError = '';
  resetComplete = false;

  private querySub?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: Auth,
    private firestore: Firestore,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController
  ) {}

  ngOnInit(): void {
    this.querySub = this.route.queryParams.subscribe((params) => {
      this.oobCode = String(params['oobCode'] || '').trim();
      const mode = String(params['mode'] || '').trim();
      if (!this.oobCode) {
        this.codeError = 'Missing reset link. Request a new password reset email from the login screen.';
        this.codeValid = false;
        return;
      }
      if (mode && mode !== 'resetPassword') {
        this.codeError = 'Invalid reset link. Request a new password reset email.';
        this.codeValid = false;
        return;
      }
      void this.validateResetCode();
    });
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
  }

  togglePasswordVisibility(ev?: Event): void {
    ev?.stopPropagation();
    this.showPassword = !this.showPassword;
  }

  toggleConfirmPasswordVisibility(ev?: Event): void {
    ev?.stopPropagation();
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  private async validateResetCode(): Promise<void> {
    this.codeError = '';
    const loading = await this.loadingController.create({
      message: 'Verifying reset link...',
      spinner: 'crescent',
    });
    await loading.present();
    try {
      this.email = await verifyPasswordResetCode(this.auth, this.oobCode);
      this.codeValid = true;
    } catch {
      this.codeValid = false;
      this.codeError =
        'This reset link is invalid or has expired. Request a new password reset email from the login screen.';
    } finally {
      await loading.dismiss();
    }
  }

  private validateForm(): boolean {
    this.formError = '';
    if (!this.newPassword || !this.confirmPassword) {
      this.formError = 'Please fill in both password fields.';
      return false;
    }
    if (this.newPassword.length < 6) {
      this.formError = 'Password must be at least 6 characters.';
      return false;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.formError = 'Passwords do not match.';
      return false;
    }
    return true;
  }

  async submitNewPassword(): Promise<void> {
    if (!this.codeValid || !this.oobCode) {
      return;
    }
    if (!this.validateForm()) {
      return;
    }

    const loading = await this.loadingController.create({
      message: 'Updating password...',
      spinner: 'crescent',
    });
    await loading.present();

    try {
      await confirmPasswordReset(this.auth, this.oobCode, this.newPassword);
      await this.syncPasswordToFirestore(this.email, this.newPassword);
      this.resetComplete = true;
      await loading.dismiss();
      await this.showAlert(
        'Password updated',
        'Your password has been reset. You can now sign in with your new password.'
      );
      await this.router.navigate(['/login']);
    } catch (error: unknown) {
      await loading.dismiss();
      const err = error as { code?: string };
      if (err?.code === 'auth/weak-password') {
        this.formError = 'Password is too weak. Please choose a stronger password.';
      } else if (err?.code === 'auth/expired-action-code' || err?.code === 'auth/invalid-action-code') {
        this.formError =
          'This reset link is invalid or has expired. Request a new password reset email.';
        this.codeValid = false;
      } else {
        this.formError = 'Failed to reset password. Please try again or request a new reset link.';
      }
      await this.showToast(this.formError, 'danger');
    }
  }

  /** Keep Registerd in sync (login can fall back to Firestore password). */
  private async syncPasswordToFirestore(email: string, newPassword: string): Promise<void> {
    const patch = {
      password: newPassword,
      passwordConfirmation: newPassword,
      passwordChanged: true,
      passwordChangeRequired: false,
    };

    try {
      const credential = await signInWithEmailAndPassword(this.auth, email, newPassword);
      const uid = credential.user.uid;
      await setDoc(doc(this.firestore, 'Registerd', uid), patch, { merge: true });
    } finally {
      try {
        await signOut(this.auth);
      } catch {
        // noop
      }
    }
  }

  goToForgotPassword(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/forgot-password']);
  }

  goToLogin(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/login']);
  }

  private async showAlert(header: string, message: string): Promise<void> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK'],
    });
    await alert.present();
  }

  private async showToast(message: string, color: string): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 3500,
      color,
      position: 'bottom',
    });
    await toast.present();
  }
}
