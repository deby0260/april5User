import { Component, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { Location } from '@angular/common';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { LoadingController, ToastController } from '@ionic/angular';

interface ConsentData {
  letter: string;
  signature: string;
  emergencyFetcher: boolean;
  oneTimeFetcher: boolean;
  dateIssued: any;
  validUntil: string;
  parentName: string;
  familyName: string;
  uid: string;
}

@Component({
  selector: 'app-consent-letter',
  templateUrl: './consent-letter.page.html',
  styleUrls: ['./consent-letter.page.scss'],
  standalone: false
})
export class ConsentLetterPage implements OnInit, AfterViewInit {
  @ViewChild('signatureCanvas', { static: false }) signatureCanvas!: ElementRef<HTMLCanvasElement>;

  consentData: ConsentData = {
    letter: '',
    signature: '',
    emergencyFetcher: false,
    oneTimeFetcher: false,
    dateIssued: null,
    validUntil: 'Today Only',
    parentName: '',
    familyName: '',
    uid: ''
  };


  private ctx: CanvasRenderingContext2D | null = null;
  private isDrawing = false;
  private lastX = 0;
  private lastY = 0;

  isSaving = false;

  constructor(
    private location: Location,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private loadingController: LoadingController,
    private toastController: ToastController
  ) { }

  async ngOnInit() {

    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      this.consentData.parentName = currentUser.fullName || currentUser.email || 'Parent';
      this.consentData.uid = currentUser.uid;


      const family = await this.familyService.getUserFamily();
      if (family) {
        this.consentData.familyName = family.name;
        console.log('Family name set for consent letter:', family.name);
      } else {
        console.log('No family found for user');
      }
    }


    this.consentData.dateIssued = new Date();
  }

  ngAfterViewInit() {

    setTimeout(() => {
      this.initializeSignatureCanvas();
    }, 100);
  }

  initializeSignatureCanvas() {
    if (this.signatureCanvas) {
      const canvas = this.signatureCanvas.nativeElement;
      this.ctx = canvas.getContext('2d');


      canvas.width = canvas.offsetWidth;
      canvas.height = 120;

      if (this.ctx) {
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 2;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
      }


      this.addCanvasEventListeners(canvas);
    }
  }

  addCanvasEventListeners(canvas: HTMLCanvasElement) {

    canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
    canvas.addEventListener('mousemove', (e) => this.draw(e));
    canvas.addEventListener('mouseup', () => this.stopDrawing());
    canvas.addEventListener('mouseout', () => this.stopDrawing());


    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent('mousedown', {
        clientX: touch.clientX,
        clientY: touch.clientY
      });
      canvas.dispatchEvent(mouseEvent);
    });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY
      });
      canvas.dispatchEvent(mouseEvent);
    });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const mouseEvent = new MouseEvent('mouseup', {});
      canvas.dispatchEvent(mouseEvent);
    });
  }

  startDrawing(e: MouseEvent) {
    if (!this.ctx) return;

    this.isDrawing = true;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    this.lastX = e.clientX - rect.left;
    this.lastY = e.clientY - rect.top;
  }

  draw(e: MouseEvent) {
    if (!this.isDrawing || !this.ctx) return;

    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(currentX, currentY);
    this.ctx.stroke();

    this.lastX = currentX;
    this.lastY = currentY;
  }

  stopDrawing() {
    this.isDrawing = false;
  }

  clearSignature() {
    if (this.ctx && this.signatureCanvas) {
      const canvas = this.signatureCanvas.nativeElement;
      this.ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.consentData.signature = '';
    }
  }

  captureSignature() {
    if (this.signatureCanvas) {
      const canvas = this.signatureCanvas.nativeElement;
      this.consentData.signature = canvas.toDataURL('image/png');
    }
  }

  async saveConsentLetter() {

    if (!this.consentData.letter.trim()) {
      await this.showToast('Please write a consent letter message');
      return;
    }


    this.captureSignature();

    if (!this.consentData.signature) {
      await this.showToast('Please provide your signature');
      return;
    }

    const loading = await this.loadingController.create({
      message: 'Saving consent letter...'
    });
    await loading.present();

    try {
      this.isSaving = true;


      const consentLetterData = {
        letter: this.consentData.letter.trim(),
        signature: this.consentData.signature,
        emergencyFetcher: this.consentData.emergencyFetcher,
        oneTimeFetcher: this.consentData.oneTimeFetcher,
        dateIssued: serverTimestamp(),
        validUntil: this.consentData.validUntil,
        parentName: this.consentData.parentName,
        familyName: this.consentData.familyName,
        uid: this.consentData.uid,
        createdAt: serverTimestamp()
      };

      console.log('Saving consent letter with data:', consentLetterData);


      const consentCollection = collection(this.firestore, 'Consent Letters');
      await addDoc(consentCollection, consentLetterData);

      await loading.dismiss();
      await this.showToast('Consent letter saved successfully!');


      this.goBack();

    } catch (error) {
      await loading.dismiss();
      console.error('Error saving consent letter:', error);
      await this.showToast('Error saving consent letter. Please try again.');
    } finally {
      this.isSaving = false;
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

  goBack() {
    this.location.back();
  }
}
