import { Component, OnInit, ViewChild, ElementRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { Firestore, collection, addDoc, serverTimestamp, query, where, getDocs } from '@angular/fire/firestore';

import { AuthService } from '../services/auth';
import { LoadingController, AlertController, ToastController } from '@ionic/angular';

interface Child {
  name: string;
  photoUrl?: string;
  gradeLevel: string;
}



@Component({
  selector: 'app-creating-family',
  templateUrl: './creating-family.page.html',
  styleUrls: ['./creating-family.page.scss'],
  standalone: false
})
export class CreatingFamilyPage implements OnInit {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  familyName: string = '';
  children: Child[] = [];

  showErrors: boolean = false;
  isCreating: boolean = false;
  currentChildIndex: number = -1;
  showChildrenSection: boolean = false;


  addChildOnlyMode: boolean = false;

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private firestore: Firestore,
    private authService: AuthService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private toastController: ToastController
  ) { }

  ngOnInit() {

    this.route.queryParams.subscribe(params => {
      if (params['addChildOnly'] === 'true') {
        this.addChildOnlyMode = true;
        this.familyName = params['familyName'] || '';
        this.showChildrenSection = true;
        this.addChild();
      }
    });
  }

  addChild() {

    if (!this.showChildrenSection) {
      this.showChildrenSection = true;
    }
    this.children.push({ name: '', gradeLevel: '', photoUrl: '' });
  }

  removeChild(index: number) {
    if (this.children.length > 1) {
      this.children.splice(index, 1);
    } else if (this.children.length === 1) {

      this.children = [];
      this.showChildrenSection = false;
    }
  }

  selectChildPhoto(childIndex: number) {
    this.currentChildIndex = childIndex;
    this.fileInput.nativeElement.click();
  }

  async onPhotoSelected(event: any) {
    const file = event.target.files[0];
    if (!file || this.currentChildIndex === -1) return;

    try {
      const loading = await this.loadingController.create({
        message: 'Processing photo...'
      });
      await loading.present();


      const base64String = await this.convertToBase64(file);


      this.children[this.currentChildIndex].photoUrl = base64String;

      await loading.dismiss();
      this.showToast('Photo uploaded successfully!');

    } catch (error) {
      console.error('Error processing photo:', error);
      this.showToast('Error processing photo. Please try again.');
    }


    this.fileInput.nativeElement.value = '';
    this.currentChildIndex = -1;
  }

  private convertToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (reader.result) {
          resolve(reader.result as string);
        } else {
          reject('Failed to convert file to base64');
        }
      };
      reader.onerror = error => reject(error);
    });
  }

  validateForm(): boolean {

    if (!this.familyName.trim()) {
      return false;
    }


    const validChildren = this.children.filter(child =>
      child.name.trim() && child.gradeLevel
    );

    return validChildren.length > 0;
  }





  async cancel() {
    if (this.familyName.trim() || this.children.some(child => child.name.trim())) {
      const alert = await this.alertController.create({
        header: 'Discard Changes',
        message: 'Are you sure you want to discard your changes?',
        buttons: [
          {
            text: 'Keep Editing',
            role: 'cancel'
          },
          {
            text: 'Discard',
            handler: () => {
              if (this.addChildOnlyMode) {
                this.router.navigate(['/created-family']);
              } else {
                this.router.navigate(['/register-create-family']);
              }
            }
          }
        ]
      });

      await alert.present();
    } else {
      if (this.addChildOnlyMode) {
        this.router.navigate(['/created-family']);
      } else {
        this.router.navigate(['/register-create-family']);
      }
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      position: 'bottom'
    });
    await toast.present();
  }
}
