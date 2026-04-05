import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { ImagePickerService, ImagePickerResult } from '../services/image-picker';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';

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
      console.error('Error selecting photo:', error);
      await this.showAlert('Image Selection Failed', 'An unexpected error occurred while selecting the image.');
    }
  }

  removePhoto() {
    this.profilePicture = '';
  }

  
  isFormValid(): boolean {
    return !!(
      this.fullName.trim() &&
      this.email.trim() &&
      this.contactNumber.trim() &&
      this.password.trim() &&
      this.confirmPassword.trim() &&
      this.profilePicture.trim() 
    );
  }

  async register() {
    if (!this.validateForm()) {
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
      console.error('Registration error:', error);
    }
  }

  goToLogin() {
    this.router.navigate(['/login']);
  }

  private async validateForm(): Promise<boolean> {
    if (!this.fullName || !this.email || !this.contactNumber || !this.password || !this.confirmPassword || !this.profilePicture) {
      await this.showAlert('Validation Error', 'Please fill in all required fields including profile picture.');
      return false;
    }

    if (this.password !== this.confirmPassword) {
      await this.showAlert('Validation Error', 'Passwords do not match.');
      return false;
    }

    if (this.password.length < 6) {
      await this.showAlert('Validation Error', 'Password must be at least 6 characters long.');
      return false;
    }

    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(this.email)) {
      await this.showAlert('Validation Error', 'Please enter a valid email address.');
      return false;
    }

    return true;
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
