import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';
import { Firestore, collection, query, where, getDocs } from '@angular/fire/firestore';
import { PasswordResetService } from '../services/password-reset.service';

@Component({
  selector: 'app-forgot-password',
  templateUrl: './forgot-password.page.html',
  styleUrls: ['./forgot-password.page.scss'],
  standalone: false
})
export class ForgotPasswordPage implements OnInit, OnDestroy {
  email: string = '';
  emailError: string = '';
  isLoading: boolean = false;
  resetSent: boolean = false;
  countdown: number = 0;
  countdownInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private router: Router,
    private firestore: Firestore,
    private passwordResetService: PasswordResetService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController
  ) { }

  ngOnInit() {
  }

  ngOnDestroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  async checkEmailExists(email: string): Promise<boolean> {
    try {
      const usersCollection = collection(this.firestore, 'Registerd');
      const emailQuery = query(usersCollection, where('email', '==', email));
      const querySnapshot = await getDocs(emailQuery);
      return !querySnapshot.empty;
    } catch {
      return false;
    }
  }

  async sendResetLink() {
    this.emailError = '';

    if (!this.email.trim()) {
      this.emailError = 'Email is required';
      return;
    }

    if (!this.validateEmail(this.email)) {
      this.emailError = 'Please enter a valid email address';
      return;
    }

    if (this.countdown > 0) {
      this.emailError = `Please wait ${this.countdown} seconds before requesting another reset link`;
      return;
    }

    this.isLoading = true;
    const loading = await this.loadingController.create({
      message: 'Checking email and sending reset link...',
      spinner: 'crescent'
    });
    await loading.present();

    try {
      const trimmedEmail = this.email.trim();
      const emailExists = await this.checkEmailExists(trimmedEmail);
      if (!emailExists) {
        this.emailError = 'No account found with this email address. Please check your email or create a new account.';
        await this.showToast('Email not found in our system', 'danger');
        return;
      }

      const result = await this.passwordResetService.requestPasswordReset(trimmedEmail);
      if (!result.success) {
        this.emailError = result.message;
        await this.showToast(result.message, 'danger');
        return;
      }

      this.resetSent = true;
      this.startCountdown(60);

      await this.showAlert(
        'Reset link sent',
        `A password reset link has been sent to ${trimmedEmail} from FetchSafe. Please check your inbox (and spam folder) and follow the instructions to reset your password.\n\nThe link will expire in about 1 hour.`
      );
    } catch {
      const errorMessage = 'Failed to send reset link. Please try again.';
      this.emailError = errorMessage;
      await this.showToast(errorMessage, 'danger');
    } finally {
      this.isLoading = false;
      await loading.dismiss();
    }
  }

  startCountdown(seconds: number) {
    this.countdown = seconds;
    this.countdownInterval = setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0 && this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.countdown = 0;
      }
    }, 1000);
  }

  async showAlert(header: string, message: string) {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK']
    });
    await alert.present();
  }

  async showToast(message: string, color: string = 'primary') {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      color,
      position: 'bottom'
    });
    await toast.present();
  }

  async resendResetLink() {
    if (this.countdown > 0) {
      await this.showToast(`Please wait ${this.countdown} seconds before resending`, 'warning');
      return;
    }
    this.resetSent = false;
    await this.sendResetLink();
  }

  goToLogin(event: Event) {
    event.preventDefault();
    this.router.navigate(['/login']);
  }

  goToRegister(event: Event) {
    event.preventDefault();
    this.router.navigate(['/register']);
  }

  clearEmail() {
    this.email = '';
    this.emailError = '';
    this.resetSent = false;
  }

  getCountdownText(): string {
    if (this.countdown > 0) {
      return `Resend in ${this.countdown}s`;
    }
    return 'Resend Reset Link';
  }
}
