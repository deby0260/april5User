import { Component, OnInit, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { Location } from '@angular/common';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService, FamilyMember } from '../services/family.service';
import { LoadingController, ToastController } from '@ionic/angular';

interface ConsentData {
  /** Auto-built letter sentence shown in the live preview and saved verbatim. */
  letter: string;
  signature: string;
  emergencyFetcher: boolean;
  oneTimeFetcher: boolean;
  dateIssued: any;
  validUntil: string;
  parentName: string;
  familyName: string;
  uid: string;
  /** UID of the family member authorized to pick up — gates view access. */
  authorizedFetcherUid: string;
  /** Display name of that authorized fetcher (cached for the viewer). */
  authorizedFetcherName: string;
  /** Selected child's name. */
  childName: string;
  /** YYYY-MM-DD this consent applies to. */
  consentDate: string;
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
    uid: '',
    authorizedFetcherUid: '',
    authorizedFetcherName: '',
    childName: '',
    consentDate: '',
  };

  /** Eligible fetchers (companions + other parents/owners), excluding self. */
  availableFetchers: FamilyMember[] = [];
  children: any[] = [];
  /** Limits the consent date picker so old / far-future dates can't be picked. */
  minConsentDate = '';
  maxConsentDate = '';

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
        await this.loadAuthorizableMembersAndChildren(family.name, currentUser.uid);
      }
    }

    this.consentData.dateIssued = new Date();
    this.initialiseConsentDateBounds();
    this.consentData.consentDate = this.todayLocalYmd();
    this.rebuildLetterPreview();
  }

  ngAfterViewInit() {
    setTimeout(() => {
      this.initializeSignatureCanvas();
    }, 100);
  }

  // -------------------------------------------------------------------------
  // Family + children loading
  // -------------------------------------------------------------------------

  /**
   * Loads family members the current user can authorize (excludes self) and
   * the family's registered children. Both feed the dropdowns in step 1 / 2.
   */
  private async loadAuthorizableMembersAndChildren(
    familyName: string,
    selfUid: string
  ): Promise<void> {
    try {
      const [members, children] = await Promise.all([
        this.familyService.getFamilyMembers(familyName),
        this.familyService.getFamilyChildren(familyName),
      ]);

      const eligibleRoles: FamilyMember['role'][] = ['owner', 'parent', 'companion'];
      const byUid = new Map<string, FamilyMember>();
      for (const m of members) {
        if (!m?.uid || m.uid === selfUid) continue;
        if (!eligibleRoles.includes(m.role)) continue;
        if (byUid.has(m.uid)) continue;
        byUid.set(m.uid, m);
      }

      this.availableFetchers = Array.from(byUid.values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
      this.children = Array.isArray(children) ? children : [];
    } catch {
      this.availableFetchers = [];
      this.children = [];
    }
  }

  // -------------------------------------------------------------------------
  // Date helpers (local YYYY-MM-DD; ion-datetime uses local strings)
  // -------------------------------------------------------------------------

  /** Allow today + the next 12 months for the consent date. */
  private initialiseConsentDateBounds(): void {
    const now = new Date();
    this.minConsentDate = this.toIsoLocalNoon(now);
    const future = new Date(now.getFullYear(), now.getMonth() + 12, now.getDate());
    this.maxConsentDate = this.toIsoLocalNoon(future);
  }

  private toIsoLocalNoon(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}T12:00:00`;
  }

  private todayLocalYmd(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** ion-datetime returns ISO with time; we keep only YYYY-MM-DD for storage. */
  get consentDateIonValue(): string {
    const d = this.consentData.consentDate;
    if (!d) return '';
    return d.includes('T') ? d : `${d}T12:00:00`;
  }

  onConsentDateChange(event: any): void {
    const raw = event?.detail?.value;
    if (!raw) return;
    this.consentData.consentDate = String(raw).split('T')[0];
    this.rebuildLetterPreview();
  }

  formatConsentDateLabel(): string {
    const ymd = this.consentData.consentDate;
    if (!ymd) return 'Pick a date';
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return 'Pick a date';
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  // -------------------------------------------------------------------------
  // Selection handlers
  // -------------------------------------------------------------------------

  onFetcherSelected(event: any): void {
    const uid = event?.detail?.value as string | null | undefined;
    if (!uid) {
      this.consentData.authorizedFetcherUid = '';
      this.consentData.authorizedFetcherName = '';
      this.rebuildLetterPreview();
      return;
    }
    const member = this.availableFetchers.find((m) => m.uid === uid);
    if (!member) return;
    this.consentData.authorizedFetcherUid = member.uid;
    this.consentData.authorizedFetcherName = member.name;
    this.rebuildLetterPreview();
  }

  onChildSelected(event: any): void {
    const name = event?.detail?.value as string | null | undefined;
    this.consentData.childName = name ? String(name) : '';
    this.rebuildLetterPreview();
  }

  /** Builds the canonical sentence from the current selections. */
  private rebuildLetterPreview(): void {
    const fetcher = (this.consentData.authorizedFetcherName || '').trim() || '[companion]';
    const child = (this.consentData.childName || '').trim() || '[child]';
    const dateLabel = this.consentData.consentDate
      ? this.formatConsentDateLabel()
      : '[date]';
    this.consentData.letter =
      `I hereby authorize ${fetcher} to pick up my child ${child} on ${dateLabel}.`;
  }

  // -------------------------------------------------------------------------
  // Signature canvas (unchanged from original implementation)
  // -------------------------------------------------------------------------

  initializeSignatureCanvas() {
    if (this.signatureCanvas) {
      const canvas = this.signatureCanvas.nativeElement;
      this.ctx = canvas.getContext('2d');

      // The previous 300x120 capture left the saved PNG so low-res that
      // the viewer page rendered it as a faint dot. Match the displayed
      // CSS width (full container) and tall enough (180px) that pen
      // strokes have real resolution to scale up cleanly in the viewer's
      // signature card.
      canvas.width = canvas.offsetWidth;
      canvas.height = 180;

      if (this.ctx) {
        this.ctx.strokeStyle = '#000';
        // Slightly thicker strokes carry the eye after scaling.
        this.ctx.lineWidth = 2.5;
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
        clientY: touch.clientY,
      });
      canvas.dispatchEvent(mouseEvent);
    });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY,
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

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  async saveConsentLetter() {
    if (!this.consentData.authorizedFetcherUid) {
      await this.showToast('Please select a companion to authorize');
      return;
    }
    if (!this.consentData.childName) {
      await this.showToast('Please select the child');
      return;
    }
    if (!this.consentData.consentDate) {
      await this.showToast('Please pick the date this consent letter is for');
      return;
    }

    this.captureSignature();
    if (!this.consentData.signature) {
      await this.showToast('Please provide your signature');
      return;
    }

    const loading = await this.loadingController.create({
      message: 'Saving consent letter...',
    });
    await loading.present();

    try {
      this.isSaving = true;

      // Always re-build right before save so the persisted text reflects the
      // user's final selections (defends against a stale preview if Angular
      // change-detection hadn't run between selection and click).
      this.rebuildLetterPreview();

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
        // New fields that drive the structured viewer + access control:
        authorizedFetcherUid: this.consentData.authorizedFetcherUid,
        authorizedFetcherName: this.consentData.authorizedFetcherName,
        childName: this.consentData.childName,
        consentDate: this.consentData.consentDate,
        createdAt: serverTimestamp(),
      };

      const consentCollection = collection(this.firestore, 'Consent Letters');
      await addDoc(consentCollection, consentLetterData);

      await loading.dismiss();
      await this.showToast('Consent letter saved successfully!');

      this.goBack();
    } catch (error) {
      await loading.dismiss();
      await this.showToast('Error saving consent letter. Please try again.');
    } finally {
      this.isSaving = false;
    }
  }

  async showToast(message: string) {
    const toast = await this.toastController.create({
      message,
      duration: 3000,
      position: 'bottom',
    });
    await toast.present();
  }

  goBack() {
    this.location.back();
  }
}
