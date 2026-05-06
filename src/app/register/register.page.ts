import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { ImagePickerService, ImagePickerResult } from '../services/image-picker';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';

type RegisterField =
  | 'fullName'
  | 'email'
  | 'contactNumber'
  | 'password'
  | 'confirmPassword'
  | 'profilePhoto';

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
  standalone: false
})
export class RegisterPage implements OnInit {
  fullName: string = '';
  email: string = '';
  contactNumber: string = '';
  password: string = '';
  confirmPassword: string = '';
  profilePicture: string = '';
  isLoading: boolean = false;

  submitAttempted = false;
  touched: Record<RegisterField, boolean> = {
    fullName: false,
    email: false,
    contactNumber: false,
    password: false,
    confirmPassword: false,
    profilePhoto: false
  };

  private readonly emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  constructor(
    private router: Router,
    private authService: AuthService,
    private imagePickerService: ImagePickerService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController
  ) { }

  ngOnInit() {
  }

  async selectPhoto() {
    this.markTouched('profilePhoto');
    try {
      const result: ImagePickerResult = await this.imagePickerService.pickImage();

      if (result.success && result.imageData) {
        
        if (this.imagePickerService.validateImageSize(result.imageData, 500)) {
          this.profilePicture = result.imageData;
          await this.showToast('Profile picture selected successfully!', 'success');
        } else {
          const compressedImage = await this.imagePickerService.compressImage(result.imageData, 0.5);
          this.profilePicture = compressedImage;
          await this.showToast('Image compressed and selected successfully!', 'success');
        }
      } else {
        if (result.error && result.error !== 'Image selection cancelled') {
          await this.showAlert('Image Selection Failed', result.error);
        }
      }
    } catch (error: any) {
      await this.showAlert('Image Selection Failed', 'An unexpected error occurred while selecting the image.');
    }
  }

  removePhoto() {
    this.profilePicture = '';
  }

  markTouched(field: RegisterField): void {
    this.touched[field] = true;
  }

  get fullNameError(): string | null {
    if (!(this.touched.fullName || this.submitAttempted)) {
      return null;
    }
    if (!this.fullName?.trim()) {
      return 'Full name is required.';
    }
    return null;
  }

  get emailError(): string | null {
    if (!(this.touched.email || this.submitAttempted)) {
      return null;
    }
    if (!this.email?.trim()) {
      return 'Email is required.';
    }
    if (!this.emailRegex.test(this.email.trim())) {
      return 'Please enter a valid email address.';
    }
    return null;
  }

  get contactNumberError(): string | null {
    if (!(this.touched.contactNumber || this.submitAttempted)) {
      return null;
    }
    if (!this.contactNumber?.trim()) {
      return 'Contact number is required.';
    }
    if (!/^\d{11}$/.test(this.contactNumber.trim())) {
      return 'Contact number must be exactly 11 digits.';
    }
    return null;
  }

  get passwordError(): string | null {
    if (!(this.touched.password || this.submitAttempted)) {
      return null;
    }
    if (!this.password?.trim()) {
      return 'Password is required.';
    }
    if (this.password.length < 6) {
      return 'Password must be at least 6 characters long.';
    }
    return null;
  }

  get confirmPasswordError(): string | null {
    if (!(this.touched.confirmPassword || this.submitAttempted)) {
      return null;
    }
    if (!this.confirmPassword?.trim()) {
      return 'Please confirm your password.';
    }
    if (this.password !== this.confirmPassword) {
      return 'Passwords do not match.';
    }
    return null;
  }

  get profilePhotoError(): string | null {
    if (!(this.touched.profilePhoto || this.submitAttempted)) {
      return null;
    }
    if (!this.profilePicture?.trim()) {
      return 'Profile picture is required to complete registration.';
    }
    return null;
  }

  isFormValid(): boolean {
    return this.isAllInputValid();
  }

  onContactNumberInput(ev: any): void {
    const value = (ev?.detail?.value ?? '').toString();
    const digitsOnly = value.replace(/\D+/g, '').slice(0, 11);

    if (digitsOnly !== value) {
      this.contactNumber = digitsOnly;
    }
  }

  private isAllInputValid(): boolean {
    return !!(
      this.fullName?.trim() &&
      this.email?.trim() &&
      this.emailRegex.test(this.email.trim()) &&
      /^\d{11}$/.test(this.contactNumber?.trim() ?? '') &&
      this.password?.trim() &&
      this.password.length >= 6 &&
      this.confirmPassword?.trim() &&
      this.password === this.confirmPassword &&
      this.profilePicture?.trim()
    );
  }

  async register() {
    this.submitAttempted = true;
    if (!this.isAllInputValid()) {
      return;
    }

    
    const loading = await this.loadingController.create({
      message: 'Creating account...',
      spinner: 'crescent'
    });
    await loading.present();

    try {
      const userData = {
        fullName: this.fullName,
        email: this.email,
        contactNumber: this.contactNumber,
        password: this.password,
        passwordConfirmation: this.confirmPassword,
        profilePicture: this.profilePicture 
      };

      const result = await this.authService.registerUser(userData);

      await loading.dismiss();

      if (result.success) {
        
        await this.showToast('Account created successfully! Please login with your credentials.', 'success');

        this.router.navigate(['/login']);
      } else {
        
        await this.showAlert('Registration Failed', result.message);
      }
    } catch (error: any) {
      await loading.dismiss();
      await this.showAlert('Registration Failed', 'An unexpected error occurred. Please try again.');
    }
  }

  goToLogin() {
    this.router.navigate(['/login']);
  }

  private async showAlert(header: string, message: string): Promise<void> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK']
    });
    await alert.present();
  }

  private async showToast(message: string, color: string = 'primary'): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      color,
      position: 'top'
    });
    await toast.present();
  }
}
