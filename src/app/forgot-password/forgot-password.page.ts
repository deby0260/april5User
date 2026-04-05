import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Auth, sendPasswordResetEmail, fetchSignInMethodsForEmail } from '@angular/fire/auth';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';
import { Firestore, collection, query, where, getDocs } from '@angular/fire/firestore';

@Component({
  selector: 'app-forgot-password',
  templateUrl: './forgot-password.page.html',
  styleUrls: ['./forgot-password.page.scss'],
  standalone: false
})
export class ForgotPasswordPage implements OnInit {
  email: string = '';
  emailError: string = '';
  isLoading: boolean = false;
  resetSent: boolean = false;
  countdown: number = 0;
  countdownInterval: any;

  constructor(
    private router: Router,
    private auth: Auth,
    private firestore: Firestore,
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
    } catch (error) {
      console.error('Error checking email existence:', error);
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


    const loading = await this.loadingController.create({
      message: 'Checking email and sending reset link...',
      spinner: 'crescent'
    });
    await loading.present();

    try {

      const emailExists = await this.checkEmailExists(this.email);
      if (!emailExists) {
        await loading.dismiss();
        this.emailError = 'No account found with this email address. Please check your email or create a new account.';
        await this.showToast('Email not found in our system', 'danger');
        return;
      }


      await sendPasswordResetEmail(this.auth, this.email);

      await loading.dismiss();
      this.resetSent = true;


      this.startCountdown(60); 


      await this.showAlert(
        'Reset Link Sent! 📧',
        `A password reset link has been sent to ${this.email}. Please check your inbox (and spam folder) and follow the instructions to reset your password.\n\nThe link will expire in 1 hour.`
      );

    } catch (error: any) {
      await loading.dismiss();
      console.error('Error sending reset link:', error);

      let errorMessage = 'Failed to send reset link. Please try again.';


      if (error.code === 'auth/user-not-found') {
        errorMessage = 'No account found with this email address. Please check your email or create a new account.';
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Please enter a valid email address.';
      } else if (error.code === 'auth/too-many-requests') {
        errorMessage = 'Too many requests. Please try again later.';
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your internet connection and try again.';
      }

      this.emailError = errorMessage;
      await this.showToast(errorMessage, 'danger');
    }
  }

  startCountdown(seconds: number) {
    this.countdown = seconds;
    this.countdownInterval = setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0) {
        clearInterval(this.countdownInterval);
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
