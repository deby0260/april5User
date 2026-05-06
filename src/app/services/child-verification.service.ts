import { Injectable } from '@angular/core';
import { Firestore, collection, query, where, getDocs, doc, updateDoc, serverTimestamp, orderBy, addDoc } from '@angular/fire/firestore';

export interface PendingChildApproval {
  id: string;
  'Child Profile Picture': string;
  'Childs Name': string;
  'Grade Level': string;
  'Family Name': string;
  'Submitted By UID': string;
  'Submitted By Name': string;
  'Submitted By Email': string;
  'Submitted By Contact': string;
  'Submitted By Profile Picture': string;
  'Name of the Creator': string;
  'Submitter Role': string;
  'Approval Status': 'pending' | 'approved' | 'rejected';
  'Date Submitted': any;
  'Admin Comments': string;
  'Date Reviewed': any;
  'Reviewed By': string;
  'Request Type': 'add_child' | 'create_family';
}

@Injectable({
  providedIn: 'root'
})
export class ChildVerificationService {

  constructor(
    private firestore: Firestore
  ) { }

  
  async getPendingChildren(): Promise<PendingChildApproval[]> {
    try {
      const pendingCollection = collection(this.firestore, 'Pending Child Approvals');
      const pendingQuery = query(
        pendingCollection,
        where('Approval Status', '==', 'pending'),
        orderBy('Date Submitted', 'desc')
      );

      const snapshot = await getDocs(pendingQuery);
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as PendingChildApproval));
    } catch (error) {
      throw error;
    }
  }

  
  async getAllPendingApprovals(): Promise<PendingChildApproval[]> {
    try {
      const pendingCollection = collection(this.firestore, 'Pending Child Approvals');
      const allPendingQuery = query(
        pendingCollection,
        orderBy('Date Submitted', 'desc')
      );

      const snapshot = await getDocs(allPendingQuery);
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as PendingChildApproval));
    } catch (error) {
      throw error;
    }
  }

  
  async approveChild(pendingId: string, adminComments: string = ''): Promise<void> {
    try {
      const adminName = 'Admin'; 

      
      const pendingDocRef = doc(this.firestore, 'Pending Child Approvals', pendingId);
      const pendingDoc = await getDocs(query(collection(this.firestore, 'Pending Child Approvals'), where('__name__', '==', pendingId)));

      if (pendingDoc.empty) {
        throw new Error('Pending approval not found');
      }

      const pendingData = pendingDoc.docs[0].data();

      
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const childData = {
        'Child Profile Picture': pendingData['Child Profile Picture'],
        'Childs Name': pendingData['Childs Name'],
        'Date Created': serverTimestamp(),
        'Family Name': pendingData['Family Name'],
        'Grade Level': pendingData['Grade Level'],
        'uid': pendingData['Submitted By UID'],
        'Parent Full Name': pendingData['Submitted By Name'],
        'Parent Email': pendingData['Submitted By Email'],
        'Parent Contact Number': pendingData['Submitted By Contact'],
        'Parent Profile Picture': pendingData['Submitted By Profile Picture'],
        'Name of the Creator': pendingData['Name of the Creator'],
        'Role': pendingData['Submitter Role'],
        
        'Approved By': adminName,
        'Date Approved': serverTimestamp(),
        'Admin Comments': adminComments
      };

      await addDoc(familiesCollection, childData);

      
      await updateDoc(pendingDocRef, {
        'Approval Status': 'approved',
        'Date Reviewed': serverTimestamp(),
        'Reviewed By': adminName,
        'Admin Comments': adminComments
      });

    } catch (error) {
      throw error;
    }
  }

  
  /**
   * Reject a pending child (stays in pending)
   */
  
  async rejectChild(pendingId: string, adminComments: string): Promise<void> {
    try {
      const adminName = 'Admin'; 
      
      const pendingDocRef = doc(this.firestore, 'Pending Child Approvals', pendingId);
      await updateDoc(pendingDocRef, {
        'Approval Status': 'rejected',
        'Date Reviewed': serverTimestamp(),
        'Reviewed By': adminName,
        'Admin Comments': adminComments
      });

    } catch (error) {
      throw error;
    }
  }

  
  async getPendingStats(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  }> {
    try {
      const allPending = await this.getAllPendingApprovals();

      const stats = {
        total: allPending.length,
        pending: allPending.filter(item => item['Approval Status'] === 'pending').length,
        approved: allPending.filter(item => item['Approval Status'] === 'approved').length,
        rejected: allPending.filter(item => item['Approval Status'] === 'rejected').length
      };

      return stats;
    } catch (error) {
      throw error;
    }
  }

  
  async searchPendingApprovals(searchTerm: string): Promise<PendingChildApproval[]> {
    try {
      const allPending = await this.getAllPendingApprovals();

      const searchLower = searchTerm.toLowerCase();
      return allPending.filter(pending =>
        pending['Childs Name'].toLowerCase().includes(searchLower) ||
        pending['Family Name'].toLowerCase().includes(searchLower) ||
        pending['Submitted By Name'].toLowerCase().includes(searchLower)
      );
    } catch (error) {
      throw error;
    }
  }

  
  async getPendingByStatus(status: 'pending' | 'approved' | 'rejected'): Promise<PendingChildApproval[]> {
    try {
      const pendingCollection = collection(this.firestore, 'Pending Child Approvals');
      const statusQuery = query(
        pendingCollection,
        where('Approval Status', '==', status),
        orderBy('Date Submitted', 'desc')
      );

      const snapshot = await getDocs(statusQuery);
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as PendingChildApproval));
    } catch (error) {
      throw error;
    }
  }

  
  async bulkApproveChildren(pendingIds: string[], adminComments: string = ''): Promise<void> {
    try {
      const approvalPromises = pendingIds.map(pendingId =>
        this.approveChild(pendingId, adminComments)
      );

      await Promise.all(approvalPromises);
    } catch (error) {
      throw error;
    }
  }
}
