import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Firestore, collection, query, where, getDocs } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService } from '../services/family.service';
import { LoadingController } from '@ionic/angular';

interface ConsentLetterData {
  letter: string;
  signature: string;
  emergencyFetcher: boolean;
  oneTimeFetcher: boolean;
  dateIssued: any;
  validUntil: string;
  parentName: string;
  familyName: string;
  uid: string;
  id?: string;
}

@Component({
  selector: 'app-view-consent-letter',
  templateUrl: './view-consent-letter.page.html',
  styleUrls: ['./view-consent-letter.page.scss'],
  standalone: false
})
export class ViewConsentLetterPage implements OnInit {
  consentLetters: ConsentLetterData[] = [];
  selectedLetter: ConsentLetterData | null = null;
  isLoading = false;

  constructor(
    private location: Location,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private loadingController: LoadingController
  ) { }

  ngOnInit() {
    this.loadConsentLetters();
  }

  async loadConsentLetters() {
    const loading = await this.loadingController.create({
      message: 'Loading family consent letters...'
    });
    await loading.present();

    try {
      this.isLoading = true;
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        await loading.dismiss();
        return;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        await loading.dismiss();
        return;
      }

      
      const familyMembers = await this.familyService.getFamilyMembers(family.name);
      const owner = familyMembers.find(member => member.role === 'owner');

      if (!owner) {
        await loading.dismiss();
        return;
      }

      
      const consentCollection = collection(this.firestore, 'Consent Letters');

      
      let querySnapshot;

      
      const familyConsentQuery = query(
        consentCollection,
        where('familyName', '==', family.name)
      );
      querySnapshot = await getDocs(familyConsentQuery);

      
      if (querySnapshot.empty) {
        const ownerConsentQuery = query(
          consentCollection,
          where('parentName', '==', owner.name)
        );
        querySnapshot = await getDocs(ownerConsentQuery);
      }

      
      if (querySnapshot.empty) {
        const ownerUIDQuery = query(
          consentCollection,
          where('uid', '==', owner.uid)
        );
        querySnapshot = await getDocs(ownerUIDQuery);
      }

      this.consentLetters = [];

      console.log(`Found ${querySnapshot.size} consent letters for family: ${family.name}`);
      console.log(`Owner name: ${owner.name}, Owner UID: ${owner.uid}`);

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        console.log('Consent letter data:', data);

        this.consentLetters.push({
          id: doc.id,
          letter: data['letter'] || '',
          signature: data['signature'] || '',
          emergencyFetcher: data['emergencyFetcher'] || false,
          oneTimeFetcher: data['oneTimeFetcher'] || false,
          dateIssued: data['dateIssued'],
          validUntil: data['validUntil'] || 'Today Only',
          parentName: data['parentName'] || 'Parent',
          familyName: data['familyName'] || family.name,
          uid: data['uid'] || ''
        });
      });

      
      if (this.consentLetters.length === 0) {
        console.log('No consent letters found with specific queries, trying broader search...');

        
        const allConsentQuery = collection(this.firestore, 'Consent Letters');
        const allQuerySnapshot = await getDocs(allConsentQuery);

        const familyMemberUIDs = familyMembers.map(member => member.uid);

        allQuerySnapshot.forEach((doc) => {
          const data = doc.data();
          const letterUID = data['uid'];

          
          if (familyMemberUIDs.includes(letterUID)) {
            console.log('Found consent letter from family member:', data);

            this.consentLetters.push({
              id: doc.id,
              letter: data['letter'] || '',
              signature: data['signature'] || '',
              emergencyFetcher: data['emergencyFetcher'] || false,
              oneTimeFetcher: data['oneTimeFetcher'] || false,
              dateIssued: data['dateIssued'],
              validUntil: data['validUntil'] || 'Today Only',
              parentName: data['parentName'] || 'Parent',
              familyName: data['familyName'] || family.name,
              uid: data['uid'] || ''
            });
          }
        });
      }

      
      this.consentLetters.sort((a, b) => {
        if (a.dateIssued && b.dateIssued) {
          const dateA = a.dateIssued.toDate ? a.dateIssued.toDate() : new Date(a.dateIssued);
          const dateB = b.dateIssued.toDate ? b.dateIssued.toDate() : new Date(b.dateIssued);
          return dateB.getTime() - dateA.getTime();
        }
        return 0;
      });

  
      if (this.consentLetters.length > 0) {
        this.selectedLetter = this.consentLetters[0];
      }

      await loading.dismiss();
    } catch (error) {
      await loading.dismiss();
      console.error('Error loading consent letters:', error);
    } finally {
      this.isLoading = false;
    }
  }

  selectLetter(letter: ConsentLetterData) {
    this.selectedLetter = letter;
  }

  goBack() {
    this.location.back();
  }
}
