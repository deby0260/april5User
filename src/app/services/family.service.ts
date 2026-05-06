import { Injectable } from '@angular/core';
import { Firestore, collection, query, where, getDocs, doc, updateDoc, arrayUnion, addDoc, serverTimestamp, deleteDoc, writeBatch } from '@angular/fire/firestore';
import { AuthService } from './auth';
import { BehaviorSubject } from 'rxjs';

export interface FamilyMember {
  id: string;
  name: string;
  email: string;
  contactNumber: string;
  profilePicture?: string;
  role: 'owner' | 'parent' | 'companion';
  joinedDate: any;
  uid: string;
}

export interface Family {
  id: string;
  name: string;
  createdDate: string;
  members: FamilyMember[];
  createdBy: string; 
}

@Injectable({
  providedIn: 'root'
})
export class FamilyService {
  private userHasFamilySubject = new BehaviorSubject<boolean | null>(null);
  userHasFamily$ = this.userHasFamilySubject.asObservable();

  constructor(
    private firestore: Firestore,
    private authService: AuthService
  ) { }

  private cacheKey(uid: string): string {
    return `userHasFamily:${uid}`;
  }

  getCachedUserHasFamily(): boolean | null {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser?.uid) return null;

    const raw = localStorage.getItem(this.cacheKey(currentUser.uid));
    if (raw === null) return null;
    return raw === 'true';
  }

  private setCachedUserHasFamily(uid: string, value: boolean): void {
    localStorage.setItem(this.cacheKey(uid), value ? 'true' : 'false');
    this.userHasFamilySubject.next(value);
  }

  async checkUserHasFamily(): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        this.userHasFamilySubject.next(false);
        return false;
      }

      
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const userFamilyQuery = query(
        familiesCollection,
        where('uid', '==', currentUser.uid)
      );
      const familyQuerySnapshot = await getDocs(userFamilyQuery);

      if (!familyQuerySnapshot.empty) {
        this.setCachedUserHasFamily(currentUser.uid, true);
        return true;
      }

      const registeredCollection = collection(this.firestore, 'Registerd');
      const userRegisteredQuery = query(
        registeredCollection,
        where('uid', '==', currentUser.uid)
      );
      const registeredQuerySnapshot = await getDocs(userRegisteredQuery);

      if (!registeredQuerySnapshot.empty) {
        const userData = registeredQuerySnapshot.docs[0].data();
        const familyName = userData['familyName'];
        const familyRole = userData['familyRole'];

        if (familyName && familyRole) {
          this.setCachedUserHasFamily(currentUser.uid, true);
          return true;
        }
      }

      this.setCachedUserHasFamily(currentUser.uid, false);
      return false;
    } catch (error) {
      this.userHasFamilySubject.next(false);
      return false;
    }
  }

  
  async getUserFamilyInfo(): Promise<{ familyName: string; familyRole: string } | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return null;
      }

      
      const registeredCollection = collection(this.firestore, 'Registerd');
      const userRegisteredQuery = query(
        registeredCollection,
        where('uid', '==', currentUser.uid)
      );
      const registeredQuerySnapshot = await getDocs(userRegisteredQuery);

      if (!registeredQuerySnapshot.empty) {
        const userData = registeredQuerySnapshot.docs[0].data();
        const familyName = userData['familyName'];
        const familyRole = userData['familyRole'];

        if (familyName && familyRole) {
          return { familyName, familyRole };
        }
      }

      
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const userFamilyQuery = query(
        familiesCollection,
        where('uid', '==', currentUser.uid)
      );
      const familyQuerySnapshot = await getDocs(userFamilyQuery);

      if (!familyQuerySnapshot.empty) {
        const familyDoc = familyQuerySnapshot.docs[0].data();
        const familyName = familyDoc['Family Name'];
        const familyRole = familyDoc['Role'] || 'owner';

        if (familyName) {
          return { familyName, familyRole };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  
  async isOriginalCreator(userUID: string, familyName: string): Promise<boolean> {
    try {
      
      const registeredCollection = collection(this.firestore, 'Registerd');
      const userQuery = query(registeredCollection, where('uid', '==', userUID));
      const userSnapshot = await getDocs(userQuery);

      if (userSnapshot.empty) {
        return false;
      }

      const userData = userSnapshot.docs[0].data();
      const userFullName = userData['fullName'] || userData['email'] || '';

      
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const familyQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName)
      );
      const familySnapshot = await getDocs(familyQuery);

      if (familySnapshot.empty) {
        return false;
      }

      
      const firstFamilyDoc = familySnapshot.docs[0].data();
      const originalCreatorName = firstFamilyDoc['Name of the Creator'] || '';

      
      return userFullName === originalCreatorName;
    } catch (error) {
      return false;
    }
  }

  async getUserFamily(): Promise<Family | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return null;
      }


      const userFamilyInfo = await this.getUserFamilyInfo();
      let familyName: string | null = null;

      if (userFamilyInfo) {
        familyName = userFamilyInfo.familyName;
      } else {

        const familiesCollection = collection(this.firestore, 'List Of Families');
        const userFamilyQuery = query(
          familiesCollection,
          where('uid', '==', currentUser.uid)
        );

        const snapshot = await getDocs(userFamilyQuery);

        if (snapshot.empty) {
          return null;
        }


        const firstChild = snapshot.docs[0].data();
        // Check for both field name formats
        familyName = firstChild['Family Name'] || firstChild['familyName'] || 'Unknown Family';
      }

      if (!familyName) {
        return null;
      }

      
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const familyDocsQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName)
      );
      const familyDocsSnapshot = await getDocs(familyDocsQuery);

      let createdDate = '';
      let createdBy = currentUser.uid;

      if (!familyDocsSnapshot.empty) {
        const familyDoc = familyDocsSnapshot.docs[0].data();
        createdDate = familyDoc['Date Created']?.toDate?.()?.toLocaleDateString() || '';
        
        const creatorName = familyDoc['Name of the Creator'];
        if (creatorName) {
          
          const registeredCollection = collection(this.firestore, 'Registerd');
          const creatorQuery = query(registeredCollection, where('fullName', '==', creatorName));
          const creatorSnapshot = await getDocs(creatorQuery);
          if (!creatorSnapshot.empty) {
            createdBy = creatorSnapshot.docs[0].data()['uid'] || currentUser.uid;
          }
        }
      }

      return {
        id: familyDocsSnapshot.empty ? 'unknown' : familyDocsSnapshot.docs[0].id,
        name: familyName,
        createdDate: createdDate,
        members: [], // Will be populated by created-family page
        createdBy: createdBy
      } as Family;
    } catch (error) {
      return null;
    }
  }

  async joinFamily(familyId: string): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        throw new Error('User not authenticated');
      }

      
      const familyDocRef = doc(this.firestore, 'List Of Families', familyId);
      await updateDoc(familyDocRef, {
        members: arrayUnion(currentUser.uid)
      });

    } catch (error) {
      throw error;
    }
  }

  async addUserToFamily(userId: string, familyName: string, role: 'parent' | 'companion' = 'companion'): Promise<void> {
    try {
      // Get user data - we need to get the actual user data for the joining user
      // Since we're adding a different user, we need to get their data from the join request

      // Create a new family entry for the joining user
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Add the user as a new family member with the same family name
      await addDoc(familiesCollection, {
        'Family Name': familyName,
        'Parent Full Name': '', // Will be updated with actual user data
        'Parent Email': '',
        'Parent Contact Number': '',
        'Child Name': '', // Will be filled when they add children
        'Child Age': '',
        'Child Profile Picture': '',
        'Date Created': serverTimestamp(),
        'Role': role,
        'uid': userId
      });

    } catch (error) {
      throw error;
    }
  }

  async addUserToFamilyWithData(userData: any, familyName: string, role: 'parent' | 'companion' = 'companion'): Promise<void> {
    try {
      // Get the user's complete data from "Registerd" collection
      const registeredCollection = collection(this.firestore, 'Registerd');
      const userQuery = query(registeredCollection, where('uid', '==', userData.requesterId));
      const userSnapshot = await getDocs(userQuery);

      let userFullData = {
        fullName: userData.requesterName || 'Unknown',
        email: userData.requesterEmail || '',
        contactNumber: userData.requesterContact || '',
        profilePicture: ''
      };

      // If user found in Registerd collection, use that data
      if (!userSnapshot.empty) {
        const registeredData = userSnapshot.docs[0].data();
        userFullData = {
          fullName: registeredData['fullName'] || userData.requesterName || 'Unknown',
          email: registeredData['email'] || userData.requesterEmail || '',
          contactNumber: registeredData['contactNumber'] || userData.requesterContact || '',
          profilePicture: registeredData['profilePicture'] || ''
        };
      }

      // Update the user's family information in the Registerd collection
      // This way they'll appear in family members without creating a blank child
      if (!userSnapshot.empty) {
        const userDocRef = userSnapshot.docs[0].ref;
        await updateDoc(userDocRef, {
          'familyName': familyName,
          'familyRole': role,
          'joinedFamilyDate': serverTimestamp()
        });
      }

      // Check if this user already has any children in this family
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const userChildrenQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName),
        where('uid', '==', userData.requesterId)
      );
      const userChildrenSnapshot = await getDocs(userChildrenQuery);

      // If user already has children in this family, update their role
      if (!userChildrenSnapshot.empty) {
        const batch = writeBatch(this.firestore);
        userChildrenSnapshot.docs.forEach(doc => {
          batch.update(doc.ref, {
            'Role': role,
            'Parent Full Name': userFullData.fullName,
            'Parent Email': userFullData.email,
            'Parent Contact Number': userFullData.contactNumber,
            'Parent Profile Picture': userFullData.profilePicture
          });
        });
        await batch.commit();
      }

    } catch (error) {
      throw error;
    }
  }

  async getFamilyMembers(familyName: string): Promise<FamilyMember[]> {
    try {
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Try querying with 'Family Name' first (new format)
      let familyQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName)
      );

      let snapshot = await getDocs(familyQuery);

      // If no results, try with 'familyName' (old format)
      if (snapshot.empty) {
        familyQuery = query(
          familiesCollection,
          where('familyName', '==', familyName)
        );
        snapshot = await getDocs(familyQuery);
      }

      const members: FamilyMember[] = [];
      const seenUIDs = new Set<string>();

      
      let originalCreatorName = '';
      if (!snapshot.empty) {
        const firstDoc = snapshot.docs[0].data();
        originalCreatorName = firstDoc['Name of the Creator'] || '';
      }


      const uniqueUIDs: string[] = [];
      const parentRecords: any[] = [];

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const uid = data['uid'];

        // Check if this is a child record
        const childName = data['Childs Name'] || data['childsName'] || data['childName'] || data['Child Name'] || '';
        if (childName && childName.trim() !== '') {
          // Even though this is a child record, it contains parent info, so we should extract it
        } else {
        }

        // Add the UID to get parent info (whether it's from a parent record or a child record)
        if (uid && !seenUIDs.has(uid)) {
          seenUIDs.add(uid);
          uniqueUIDs.push(uid);
          parentRecords.push(data);
        }
      });

      
      const registeredCollection = collection(this.firestore, 'Registerd');

      for (const uid of uniqueUIDs) {
        try {
          const userQuery = query(registeredCollection, where('uid', '==', uid));
          const userSnapshot = await getDocs(userQuery);

          if (!userSnapshot.empty) {
            const userData = userSnapshot.docs[0].data();


            let memberRole: 'owner' | 'parent' | 'companion' = 'companion';


            const userFullName = userData['fullName'] || userData['email'] || '';
            if (originalCreatorName && userFullName === originalCreatorName) {
              memberRole = 'owner';
            } else {
              // FIRST: Check familyRole from Registerd collection
              const familyRoleFromRegisterd = userData['familyRole'];
              if (familyRoleFromRegisterd) {
                const role = familyRoleFromRegisterd.toLowerCase();
                if (role === 'parent' || role === 'parents') {
                  memberRole = 'parent';
                } else if (role === 'companion') {
                  memberRole = 'companion';
                } else if (role === 'owner') {
                  memberRole = 'owner';
                }
              } else {
                // FALLBACK: Check Role from List Of Families collection
                const userFamilyDoc = snapshot.docs.find(doc => doc.data()['uid'] === uid);
                if (userFamilyDoc) {
                  const assignedRole = userFamilyDoc.data()['Role'];
                  if (assignedRole === 'owner' || assignedRole === 'parent' || assignedRole === 'companion') {
                    memberRole = assignedRole;
                  } else {
                    memberRole = 'companion';
                  }
                }
              }
            }

            members.push({
              id: uid,
              name: userData['fullName'] || userData['email'] || 'Unknown',
              email: userData['email'] || '',
              contactNumber: userData['contactNumber'] || '',
              profilePicture: userData['profilePicture'] || '',
              role: memberRole,
              joinedDate: userData['createdAt'] || new Date(),
              uid: uid
            });
          } else {
            const userFamilyDoc = snapshot.docs.find(doc => doc.data()['uid'] === uid);
            if (userFamilyDoc) {
              const familyData = userFamilyDoc.data();
              let memberRole: 'owner' | 'parent' | 'companion' = 'companion';

              const memberName = familyData['Parent Full Name'] || familyData['parentFullName'] || '';
              if (originalCreatorName && memberName === originalCreatorName) {
                memberRole = 'owner';
              } else {
                const assignedRole = familyData['Role'];
                if (assignedRole === 'owner' || assignedRole === 'parent' || assignedRole === 'companion') {
                  memberRole = assignedRole;
                } else {
                  memberRole = 'companion';
                }
              }

              members.push({
                id: uid,
                name: familyData['Parent Full Name'] || familyData['parentFullName'] || 'Unknown',
                email: familyData['Parent Email'] || familyData['parentEmail'] || '',
                contactNumber: familyData['Parent Contact Number'] || familyData['parentContactNumber'] || '',
                profilePicture: familyData['Parent Profile Picture'] || familyData['parentProfilePicture'] || '',
                role: memberRole,
                joinedDate: familyData['Date Created'] || new Date(),
                uid: uid
              });
            } else {
            }
          }
        } catch (userError) {
        }
      }

      const registeredUsersCollection = collection(this.firestore, 'Registerd');
      const joinedUsersQuery = query(registeredUsersCollection, where('familyName', '==', familyName));
      const joinedUsersSnapshot = await getDocs(joinedUsersQuery);

      joinedUsersSnapshot.docs.forEach(doc => {
        const userData = doc.data();
        const uid = userData['uid'];

        if (uid && !seenUIDs.has(uid)) {
          seenUIDs.add(uid);

          const memberRole = userData['familyRole'] || 'companion';

          members.push({
            id: uid,
            name: userData['fullName'] || userData['email'] || 'Unknown',
            email: userData['email'] || '',
            contactNumber: userData['contactNumber'] || '',
            profilePicture: userData['profilePicture'] || '',
            role: memberRole as 'owner' | 'parent' | 'companion',
            joinedDate: userData['joinedFamilyDate'] || userData['createdAt'] || new Date(),
            uid: uid
          });
        }
      });

      const validMembers = members.filter(member =>
        member.uid &&
        member.uid.trim() !== '' &&
        member.name &&
        member.name.trim() !== '' &&
        member.name !== 'Unknown'
      );

      return validMembers;
    } catch (error) {
      return [];
    }
  }

  async updateMemberRole(familyName: string, memberUID: string, newRole: 'parent' | 'companion'): Promise<{ success: boolean; message: string }> {
    try {
      const isOriginalCreator = await this.isOriginalCreator(memberUID, familyName);
      if (isOriginalCreator) {
        return { success: false, message: 'Cannot change the role of the original family creator. The creator maintains permanent ownership.' };
      }

      const familiesCollection = collection(this.firestore, 'List Of Families');
      const memberQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName),
        where('uid', '==', memberUID)
      );

      const snapshot = await getDocs(memberQuery);

      const updatePromises = snapshot.docs.map(doc =>
        updateDoc(doc.ref, { 'Role': newRole })
      );

      await Promise.all(updatePromises);

      const registeredCollection = collection(this.firestore, 'Registerd');
      const userRegisteredQuery = query(
        registeredCollection,
        where('uid', '==', memberUID),
        where('familyName', '==', familyName)
      );
      const registeredSnapshot = await getDocs(userRegisteredQuery);

      if (!registeredSnapshot.empty) {
        const userDocRef = registeredSnapshot.docs[0].ref;
        await updateDoc(userDocRef, {
          'familyRole': newRole
        });
      }

      return { success: true, message: 'Member role updated successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to update member role' };
    }
  }

  async getFamilyChildren(familyName: string): Promise<any[]> {
    try {
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Try querying with 'Family Name' first (new format)
      let q = query(familiesCollection, where('Family Name', '==', familyName));
      let querySnapshot = await getDocs(q);

      // If no results, try with 'familyName' (old format)
      if (querySnapshot.empty) {
        q = query(familiesCollection, where('familyName', '==', familyName));
        querySnapshot = await getDocs(q);
      }

      const children: any[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();

        // Check for child name in multiple possible field formats
        const childName = data['Childs Name'] || data['childsName'] || data['childName'] || data['Child Name'] || '';

        if (childName && childName.trim() !== '') {
          const child = {
            name: childName,
            grade: data['Grade Level'] || data['gradeLevel'] || '',
            profilePicture: data['Child Profile Picture'] || data['childProfilePicture'] || ''
          };
          children.push(child);
        } else {
        }
      });

      return children;
    } catch (error) {
      return [];
    }
  }

  async removeFamilyMember(familyName: string, memberUID: string): Promise<{ success: boolean; message: string }> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return { success: false, message: 'User not authenticated' };
      }

      const isOriginalCreator = await this.isOriginalCreator(memberUID, familyName);
      if (isOriginalCreator) {
        return { success: false, message: 'Cannot remove the original family creator. The creator has permanent family ownership.' };
      }

      if (memberUID === currentUser.uid) {
        return { success: false, message: 'You cannot remove yourself. Use the leave family option instead.' };
      }

      const familiesCollection = collection(this.firestore, 'List Of Families');
      const memberQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName),
        where('uid', '==', memberUID)
      );

      const snapshot = await getDocs(memberQuery);
      const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
      await Promise.all(deletePromises);

      return { success: true, message: 'Member removed successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to remove member' };
    }
  }

  /**
   * Check if a parent is verified by admin in the List Of Families
   * @param parentUid - The UID of the parent to check
   * @returns True if parent is verified, false otherwise
   */
  async isParentVerifiedByAdmin(parentUid: string): Promise<{
    isVerified: boolean;
    familyName: string | null;
    verificationDate: any;
  }> {
    try {
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const q = query(
        familiesCollection,
        where('uid', '==', parentUid)
      );

      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        return { isVerified: false, familyName: null, verificationDate: null };
      }

      // Check each document for verification status
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const isVerified = data['verified At'] || data['verifiedAt'] || data['verified'];
        const familyName = data['Family Name'] || data['familyName'];

        if (isVerified) {
          return {
            isVerified: true,
            familyName: familyName,
            verificationDate: isVerified
          };
        }
      }

      return { isVerified: false, familyName: null, verificationDate: null };
    } catch (error) {
      return { isVerified: false, familyName: null, verificationDate: null };
    }
  }
}
