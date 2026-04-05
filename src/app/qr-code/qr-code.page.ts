import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { LoadingController, ToastController } from '@ionic/angular';
import { AuthService, UserData } from '../services/auth';
import { FamilyService } from '../services/family.service';

import {
  Firestore,
  collection,
  getDocs,
  query,
  where,
} from '@angular/fire/firestore';

@Component({
  selector: 'app-qr-code',
  templateUrl: './qr-code.page.html',
  styleUrls: ['./qr-code.page.scss'],
  standalone: false,
})
export class QrCodePage implements OnInit {
  qrPattern: boolean[] = [];
  qrCodeImageUrl = '';
  currentUser: UserData | null = null;
  isLoading = false;

  private readonly QR_STORAGE_KEY = 'fetchsafe_qr_data_v2';
  private readonly QR_EXPIRY_HOURS = 24;
  private isUsingCachedQR = false;

  private readonly qrApiBaseUrl = 'https://api.qrserver.com/v1/create-qr-code/';
  private readonly qrApiParams = {
    size: '280x280',
    format: 'png',
    margin: 10,
    ecc: 'M',
    color: '000000',
    bgcolor: 'ffffff',
  };

  private readonly hostedBaseUrl = 'https://fetchsafe2.web.app';

  constructor(
    private location: Location,
    private afs: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private loadingController: LoadingController,
    private toastController: ToastController
  ) {}

  async ngOnInit() {
    this.currentUser = this.authService.getCurrentUser();

    if (this.currentUser) {
      
      this.clearCachedQRCode();
      await this.generateUniqueQRCode();
    } else {
      this.generateQRPattern();
    }
  }

  isOfflineMode(): boolean { return this.isUsingCachedQR; }

  private async findFamilyNameForCurrentUser(): Promise<string | null> {
    if (!this.currentUser) return null;

    try {
      const familiesRef = collection(this.afs, 'List Of Families');

      let snap = this.currentUser.email
        ? await getDocs(query(familiesRef, where('Parent Email', '==', this.currentUser.email)))
        : null;

      // If no results with 'Parent Email', try 'parentEmail'
      if (!snap || snap.empty) {
        snap = this.currentUser.email
          ? await getDocs(query(familiesRef, where('parentEmail', '==', this.currentUser.email)))
          : null;
      }

      if (!snap || snap.empty) {
        if (this.currentUser.fullName) {
          snap = await getDocs(
            query(familiesRef, where('Parent Full Name', '==', this.currentUser.fullName))
          );
        }
      }

      // If no results with 'Parent Full Name', try 'parentFullName'
      if (!snap || snap.empty) {
        if (this.currentUser.fullName) {
          snap = await getDocs(
            query(familiesRef, where('parentFullName', '==', this.currentUser.fullName))
          );
        }
      }

      if (snap && !snap.empty) {
        const first = snap.docs[0].data() as any;
        const familyName = first['Family Name'] || first['familyName'];
        if (familyName) {
          console.log('🏠 Found family as creator/owner:', familyName);
          return familyName;
        }
      }

      const registeredCollection = collection(this.afs, 'Registerd');
      const userRegisteredQuery = query(
        registeredCollection,
        where('uid', '==', this.currentUser.uid)
      );
      const registeredQuerySnapshot = await getDocs(userRegisteredQuery);

      if (!registeredQuerySnapshot.empty) {
        const userData = registeredQuerySnapshot.docs[0].data();
        const familyName = userData['familyName'];
        const familyRole = userData['familyRole'];

        if (familyName && familyRole) {
          console.log(`🏠 Found family as ${familyRole} member:`, familyName);
          return familyName;
        }
      }

      const joinRequestsRef = collection(this.afs, 'Join Requests');
      const approvedRequestQuery = query(
        joinRequestsRef,
        where('requesterId', '==', this.currentUser.uid),
        where('status', '==', 'approved')
      );
      const approvedRequestSnapshot = await getDocs(approvedRequestQuery);

      if (!approvedRequestSnapshot.empty) {
        const joinRequest = approvedRequestSnapshot.docs[0].data() as any;
        const familyName = joinRequest['familyName'];
        if (familyName) {
          console.log('🏠 Found family through approved join request:', familyName);
          return familyName;
        }
      }

      console.log('❌ No family found for current user');
      return null;

    } catch (error) {
      console.error('❌ Error finding family for current user:', error);
      return null;
    }
  }

  private async buildComprehensiveFamilyData(familyName: string): Promise<any> {
    try {
      console.log('🔍 Building comprehensive family data for:', familyName);

      const familyMembers = await this.familyService.getFamilyMembers(familyName);
      console.log('👨‍👩‍👧‍👦 Family members:', familyMembers);

      const children = await this.familyService.getFamilyChildren(familyName);
      console.log('👶 Children:', children);

      const sessionId = this.generateSessionId();
      const timestamp = new Date().toISOString();

      const familyData = {
        familyName: familyName,
        authorizer: {
          fullName: this.currentUser?.fullName || 'Unknown',
          email: this.currentUser?.email || '',
          contactNumber: this.currentUser?.contactNumber || ''
        },
        children: children.map(child => ({
          name: child.name || 'Unknown',
          grade: child.grade || 'Not specified',
          hasProfilePicture: !!(child.profilePicture && child.profilePicture.trim())
        })),
        familyMembers: familyMembers.map(member => ({
          name: member.name || 'Unknown',
          email: member.email || '',
          contactNumber: member.contactNumber || '',
          role: member.role || 'Family Member',
          hasProfilePicture: !!(member.profilePicture && member.profilePicture.trim()),
          joinedDate: member.joinedDate || null
        })),
        metadata: {
          generatedAt: timestamp,
          sessionId: sessionId,
          appName: 'FetchSafe',
          version: '1.0',
          generatedBy: this.currentUser?.uid || 'unknown'
        }
      };

      console.log('📄 Comprehensive family data (optimized for QR):', familyData);
      return familyData;

    } catch (error) {
      console.error('❌ Error building comprehensive family data:', error);
      throw error;
    }
  }

  async generateUniqueQRCode() {
    if (!this.currentUser) return;

    this.isLoading = true;
    const loading = await this.loadingController.create({
      message: 'Generating Family QR Code...',
      spinner: 'crescent',
    });
    await loading.present();

    try {
      const familyName = await this.findFamilyNameForCurrentUser();
      if (!familyName) throw new Error('No family found for this user');

      console.log('🔍 Generating QR for family:', familyName);

      
      // `fam` duplicates `family` so short links / scanners that clip the query still often retain a working param
      const enc = encodeURIComponent(familyName);
      const auth = encodeURIComponent(this.currentUser.email || '');
      const hostedUrl = `${this.hostedBaseUrl}?family=${enc}&fam=${enc}&authorizer=${auth}`;

      console.log('🔗 QR URL:', hostedUrl);

      const familyData = {
        familyName,
        authorizer: this.currentUser.email,
        generatedAt: new Date().toISOString()
      };

      const qrUrl = await this.generateQRCodeImage(hostedUrl);
      if (!qrUrl) throw new Error('Failed to generate QR code');

      console.log('✅ QR Image URL:', qrUrl);

      this.qrCodeImageUrl = qrUrl;
      this.qrPattern = [];
      this.isUsingCachedQR = false;

      this.cacheQRCode(qrUrl, hostedUrl, familyData);
      await this.showToast('QR Code generated successfully!', 'success');
    } catch (err) {
      console.error('❌ QR Generation Error:', err);
      await this.showToast('Failed to generate QR. Showing fallback pattern.', 'warning');
      this.generateQRPattern();
    } finally {
      this.isLoading = false;
      await loading.dismiss();
    }
  }

  private buildQRCodeApiUrl(data: string): string {
    const params = new URLSearchParams({
      size: this.qrApiParams.size,
      format: this.qrApiParams.format,
      margin: String(this.qrApiParams.margin),
      ecc: this.qrApiParams.ecc,
      color: this.qrApiParams.color,
      bgcolor: this.qrApiParams.bgcolor,
    });
    params.set('data', data);
    return `${this.qrApiBaseUrl}?${params.toString()}`;
  }

  private async generateQRCodeImage(urlToEncode: string): Promise<string | null> {
    const primary = this.buildQRCodeApiUrl(urlToEncode);
    if (await this.testImage(primary)) return primary;

    const g = `https://chart.googleapis.com/chart?chs=280x280&cht=qr&chl=${encodeURIComponent(
      urlToEncode
    )}`;
    if (await this.testImage(g)) return g;

    return null;
  }

  private testImage(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => resolve(false), 5000);
      img.onload = () => { clearTimeout(t); resolve(true); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.src = url;
    });
  }

  private async showToast(message: string, color: string = 'primary') {
    const toast = await this.toastController.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }

  generateQRPattern() {
    this.qrPattern = [];
    for (let i = 0; i < 441; i++) {
      const r = Math.floor(i / 21), c = i % 21;
      if (this.isCornerPattern(r, c)) this.qrPattern.push(true);
      else if (r === 6 || c === 6) this.qrPattern.push((r + c) % 2 === 0);
      else this.qrPattern.push(Math.random() > 0.5);
    }
  }
  private isCornerPattern(r: number, c: number) {
    if (r < 7 && c < 7) return this.isInCornerSquare(r, c);
    if (r < 7 && c > 13) return this.isInCornerSquare(r, c - 14);
    if (r > 13 && c < 7) return this.isInCornerSquare(r - 14, c);
    return false;
  }
  private isInCornerSquare(r: number, c: number) {
    if (r === 0 || r === 6 || c === 0 || c === 6) return true;
    if (r >= 2 && r <= 4 && c >= 2 && c <= 4) return true;
    return false;
  }

  async refreshCode(): Promise<void> {
    if (!this.currentUser) {
      this.generateQRPattern();
      await this.showToast('QR Code pattern refreshed', 'primary');
      return;
    }
    await this.forceRefreshQRCode();
  }

  async onQRImageError(_event?: Event) {
    await this.showToast('Failed to load QR code image. Showing fallback pattern.', 'warning');
    this.qrCodeImageUrl = '';
    this.generateQRPattern();
  }

  private cacheQRCode(imageUrl: string, websiteUrl: string, data: any): void {
    const now = Date.now();
    const payload = {
      imageUrl, websiteUrl, data,
      timestamp: now,
      userId: this.currentUser?.uid,
      expiresAt: now + this.QR_EXPIRY_HOURS * 60 * 60 * 1000,
    };
    localStorage.setItem(this.QR_STORAGE_KEY, JSON.stringify(payload));
  }
  private loadCachedQRCode(): any | null {
    try { const s = localStorage.getItem(this.QR_STORAGE_KEY); return s ? JSON.parse(s) : null; }
    catch { return null; }
  }
  private isQRCodeValid(cached: any): boolean {
    if (!cached) return false;
    if (Date.now() > cached.expiresAt) { this.clearCachedQRCode(); return false; }
    if (cached.userId !== this.currentUser?.uid) { this.clearCachedQRCode(); return false; }
    return true;
  }
  private clearCachedQRCode(): void { localStorage.removeItem(this.QR_STORAGE_KEY); }

  async forceRefreshQRCode(): Promise<void> {
    this.clearCachedQRCode();
    this.isUsingCachedQR = false;
    await this.generateUniqueQRCode();
    await this.showToast('QR Code refreshed successfully!', 'success');
  }

  private generateSessionId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = ''; for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  goBack() { this.location.back(); }
}
 