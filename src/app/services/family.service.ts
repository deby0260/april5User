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
        console.log('checkUserHasFamily: User has family documents in List Of Families');
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
          console.log(`checkUserHasFamily: User is a ${familyRole} in family "${familyName}"`);
          this.setCachedUserHasFamily(currentUser.uid, true);
          return true;
        }
      }

      console.log('checkUserHasFamily: User does not have a family');
      this.setCachedUserHasFamily(currentUser.uid, false);
      return false;
    } catch (error) {
      console.error('Error checking user family status:', error);
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
          console.log(`getUserFamilyInfo: Found family info - ${familyRole} in "${familyName}"`);
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
          console.log(`getUserFamilyInfo: Found family info in List Of Families - ${familyRole} in "${familyName}"`);
          return { familyName, familyRole };
        }
      }

      console.log('getUserFamilyInfo: No family info found');
      return null;
    } catch (error) {
      console.error('Error getting user family info:', error);
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
      console.error('Error checking if user is original creator:', error);
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
      console.error('Error getting user family:', error);
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
      console.error('Error joining family:', error);
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
      console.error('Error adding user to family:', error);
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

      console.log(`User ${userFullData.fullName} added to family ${familyName} with role ${role}`);
      console.log('User will appear in family members list and can add children when ready');

    } catch (error) {
      console.error('Error adding user to family with data:', error);
      throw error;
    }
  }

  async getFamilyMembers(familyName: string): Promise<FamilyMember[]> {
    try {
      console.log('getFamilyMembers: Searching for family:', familyName);
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Try querying with 'Family Name' first (new format)
      let familyQuery = query(
        familiesCollection,
        where('Family Name', '==', familyName)
      );

      let snapshot = await getDocs(familyQuery);

      // If no results, try with 'familyName' (old format)
      if (snapshot.empty) {
        console.log('No results with "Family Name", trying "familyName"');
        familyQuery = query(
          familiesCollection,
          where('familyName', '==', familyName)
        );
        snapshot = await getDocs(familyQuery);
      }

      console.log('getFamilyMembers: Found', snapshot.size, 'documents');

      const members: FamilyMember[] = [];
      const seenUIDs = new Set<string>();

      
      let originalCreatorName = '';
      if (!snapshot.empty) {
        const firstDoc = snapshot.docs[0].data();
        originalCreatorName = firstDoc['Name of the Creator'] || '';
        console.log('Original creator name:', originalCreatorName);
      }


      const uniqueUIDs: string[] = [];
      const parentRecords: any[] = [];

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const uid = data['uid'];
        console.log('Document UID:', uid, 'Data keys:', Object.keys(data));

        // Check if this is a child record
        const childName = data['Childs Name'] || data['childsName'] || data['childName'] || data['Child Name'] || '';
        if (childName && childName.trim() !== '') {
          console.log('Found child record:', childName, 'with parent UID:', uid);
          // Even though this is a child record, it contains parent info, so we should extract it
        } else {
          console.log('Found parent record for UID:', uid);
        }

        // Add the UID to get parent info (whether it's from a parent record or a child record)
        if (uid && !seenUIDs.has(uid)) {
          seenUIDs.add(uid);
          uniqueUIDs.push(uid);
          parentRecords.push(data);
          console.log('Added unique UID:', uid);
        }
      });

      console.log('Unique UIDs found:', uniqueUIDs);
      console.log('Parent records found:', parentRecords.length);

      
      const registeredCollection = collection(this.firestore, 'Registerd');

      for (const uid of uniqueUIDs) {
        try {
          console.log(`Looking up user data for UID: ${uid}`);
          const userQuery = query(registeredCollection, where('uid', '==', uid));
          const userSnapshot = await getDocs(userQuery);

          if (!userSnapshot.empty) {
            console.log(`Found user in Registered collection for UID: ${uid}`);
            const userData = userSnapshot.docs[0].data();


            let memberRole: 'owner' | 'parent' | 'companion' = 'companion';


            const userFullName = userData['fullName'] || userData['email'] || '';
            if (originalCreatorName && userFullName === originalCreatorName) {
              memberRole = 'owner';
              console.log(`User is original creator: ${userFullName}`);
            } else {
              // FIRST: Check familyRole from Registerd collection
              const familyRoleFromRegisterd = userData['familyRole'];
              if (familyRoleFromRegisterd) {
                const role = familyRoleFromRegisterd.toLowerCase();
                if (role === 'parent' || role === 'parents') {
                  memberRole = 'parent';
                  console.log(`Role from Registerd collection (familyRole): parent`);
                } else if (role === 'companion') {
                  memberRole = 'companion';
                  console.log(`Role from Registerd collection (familyRole): companion`);
                } else if (role === 'owner') {
                  memberRole = 'owner';
                  console.log(`Role from Registerd collection (familyRole): owner`);
                }
              } else {
                // FALLBACK: Check Role from List Of Families collection
                const userFamilyDoc = snapshot.docs.find(doc => doc.data()['uid'] === uid);
                if (userFamilyDoc) {
                  const assignedRole = userFamilyDoc.data()['Role'];
                  if (assignedRole === 'owner' || assignedRole === 'parent' || assignedRole === 'companion') {
                    memberRole = assignedRole;
                    console.log(`Role from List Of Families (fallback): ${assignedRole}`);
                  } else {
                    memberRole = 'companion';
                    console.log(`No valid role found, defaulting to companion`);
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
            console.log(`Added member from Registered: ${userData['fullName'] || userData['email']}`);
          } else {
            console.log(`User not found in Registered collection for UID: ${uid}, checking family records`);
            const userFamilyDoc = snapshot.docs.find(doc => doc.data()['uid'] === uid);
            if (userFamilyDoc) {
              const familyData = userFamilyDoc.data();
              console.log(`Found family record for UID ${uid}:`, familyData);
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
              console.log(`Added member from family record: ${memberName}`);
            } else {
              console.log(`No family record found for UID: ${uid}`);
            }
          }
        } catch (userError) {
          console.error(`Error getting user data for UID ${uid}:`, userError);
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

      console.log('Family members found:', validMembers);
      console.log(`Filtered out ${members.length - validMembers.length} invalid members`);

      return validMembers;
    } catch (error) {
      console.error('Error getting family members:', error);
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
      console.error('Error updating member role:', error);
      return { success: false, message: 'Failed to update member role' };
    }
  }

  async getFamilyChildren(familyName: string): Promise<any[]> {
    try {
      console.log('getFamilyChildren: Searching for family:', familyName);
      const familiesCollection = collection(this.firestore, 'List Of Families');

      // Try querying with 'Family Name' first (new format)
      let q = query(familiesCollection, where('Family Name', '==', familyName));
      let querySnapshot = await getDocs(q);

      // If no results, try with 'familyName' (old format)
      if (querySnapshot.empty) {
        console.log('No results with "Family Name", trying "familyName"');
        q = query(familiesCollection, where('familyName', '==', familyName));
        querySnapshot = await getDocs(q);
      }

      console.log('getFamilyChildren: Found', querySnapshot.size, 'documents');

      const children: any[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        console.log('Document data:', data);

        // Check for child name in multiple possible field formats
        const childName = data['Childs Name'] || data['childsName'] || data['childName'] || data['Child Name'] || '';
        console.log('Checking for child name:', childName);

        if (childName && childName.trim() !== '') {
          const child = {
            name: childName,
            grade: data['Grade Level'] || data['gradeLevel'] || '',
            profilePicture: data['Child Profile Picture'] || data['childProfilePicture'] || ''
          };
          console.log('Adding child:', child);
          children.push(child);
        } else {
          console.log('No child name found in document');
        }
      });

      console.log('Final children array:', children);
      return children;
    } catch (error) {
      console.error('Error getting family children:', error);
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
      console.error('Error removing family member:', error);
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
      console.error('Error checking parent verification status:', error);
      return { isVerified: false, familyName: null, verificationDate: null };
    }
  }
}
