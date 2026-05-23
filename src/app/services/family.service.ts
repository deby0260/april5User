import { Injectable } from '@angular/core';
import { Firestore, collection, query, where, getDocs, doc, getDoc, updateDoc, arrayUnion, addDoc, serverTimestamp, deleteDoc, writeBatch } from '@angular/fire/firestore';
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

export interface FamilyChildRecord {
  name: string;
  grade: string;
  profilePicture: string;
  isVerified?: boolean;
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
        const familyRole = familyDoc['Role'] || familyDoc['role'] || 'companion';

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

      // Resolve every member UID against `Registerd` AND fetch the joined-users
      // index in a single parallel batch instead of N+1 sequential queries.
      // `Registerd` doc IDs equal the user UID (see auth.registerUser), so we
      // can use getDoc(doc(...)) directly — far cheaper than where('uid','==')
      // queries and parallelizable via Promise.all.
      const registeredUsersCollection = collection(this.firestore, 'Registerd');
      const joinedUsersQuery = query(registeredUsersCollection, where('familyName', '==', familyName));
      const [memberSnaps, joinedUsersSnapshot] = await Promise.all([
        Promise.all(
          uniqueUIDs.map((uid) =>
            getDoc(doc(this.firestore, 'Registerd', uid)).catch(() => null)
          )
        ),
        getDocs(joinedUsersQuery),
      ]);

      for (let i = 0; i < uniqueUIDs.length; i++) {
        const uid = uniqueUIDs[i];
        const snap = memberSnaps[i];
        try {
          if (snap && snap.exists()) {
            const userData = snap.data() as any;

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
            }
          }
        } catch (userError) {
        }
      }

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

  private pickFamilyField<T = unknown>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && v !== '') return v as T;
    }
    return undefined;
  }

  private splitChildNames(raw: string): string[] {
    const text = String(raw || '').trim();
    if (!text) return [];
    return text
      .split(/[,;|\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private gradeForIndexedChild(data: Record<string, unknown>, index: string): string {
    const idx = String(index || '').trim();
    if (!idx) return '';
    return String(
      this.pickFamilyField(
        data,
        `Grade Level ${idx}`,
        `Child ${idx} Grade Level`,
        `Child Grade Level ${idx}`,
        `gradeLevel${idx}`
      ) || ''
    );
  }

  private photoForIndexedChild(data: Record<string, unknown>, index: string): string {
    const idx = String(index || '').trim();
    if (!idx) return '';
    return String(
      this.pickFamilyField(
        data,
        `Child ${idx} Profile Picture`,
        `Child Profile Picture ${idx}`,
        `childProfilePicture${idx}`,
        `Child Profile Picture ${idx}`
      ) || ''
    );
  }

  /**
   * A family document may represent one child (scalar fields) or several
   * (array, comma-separated names, or numbered fields like "Childs Name 2").
   */
  extractChildrenFromFamilyDoc(data: Record<string, unknown>): FamilyChildRecord[] {
    const results: FamilyChildRecord[] = [];
    const seen = new Set<string>();

    const addChild = (
      name: string,
      grade = '',
      profilePicture = '',
      isVerified?: boolean
    ) => {
      const trimmed = String(name || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        name: trimmed,
        grade: String(grade || ''),
        profilePicture: String(profilePicture || ''),
        ...(isVerified !== undefined ? { isVerified } : {}),
      });
    };

    const arrayFields = ['children', 'Children', 'childList', 'Child List', 'kids'];
    for (const field of arrayFields) {
      const arr = data[field];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === 'string') {
          this.splitChildNames(item).forEach((n) => addChild(n));
        } else if (item && typeof item === 'object') {
          const row = item as Record<string, unknown>;
          addChild(
            String(
              this.pickFamilyField(row, 'name', 'childName', 'Childs Name', 'Child Name', 'fullName') || ''
            ),
            String(this.pickFamilyField(row, 'grade', 'gradeLevel', 'Grade Level', 'Grade') || ''),
            String(
              this.pickFamilyField(
                row,
                'profilePicture',
                'childProfilePicture',
                'Child Profile Picture'
              ) || ''
            ),
            !!this.pickFamilyField(row, 'Child Verified', 'childVerified', 'isVerified')
          );
        }
      }
    }

    const primaryName = this.pickFamilyField<string>(
      data,
      'Childs Name',
      'childsName',
      'childName',
      'Child Name'
    );
    const primaryGrade = String(
      this.pickFamilyField(data, 'Grade Level', 'gradeLevel', 'Child Grade') || ''
    );
    const primaryPhoto = String(
      this.pickFamilyField(data, 'Child Profile Picture', 'childProfilePicture') || ''
    );
    const primaryVerified = !!this.pickFamilyField(data, 'Child Verified', 'childVerified');

    if (primaryName) {
      const names = this.splitChildNames(String(primaryName));
      if (names.length > 1) {
        names.forEach((n) => addChild(n, primaryGrade, primaryPhoto, primaryVerified));
      } else {
        addChild(String(primaryName), primaryGrade, primaryPhoto, primaryVerified);
      }
    }

    const secondaryName = this.pickFamilyField<string>(
      data,
      'Second Childs Name',
      'Second Child Name',
      'Child 2 Name',
      'child2Name',
      'Child2 Name'
    );
    if (secondaryName) {
      addChild(
        String(secondaryName),
        String(
          this.pickFamilyField(
            data,
            'Second Child Grade Level',
            'Grade Level 2',
            'Child 2 Grade Level',
            'gradeLevel2'
          ) || ''
        ),
        String(
          this.pickFamilyField(
            data,
            'Second Child Profile Picture',
            'Child 2 Profile Picture',
            'Child Profile Picture 2',
            'childProfilePicture2'
          ) || ''
        )
      );
    }

    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;

      if (typeof value === 'object' && !Array.isArray(value)) {
        if (/^child\s*\d+$/i.test(key) || /^child\d+$/i.test(key)) {
          const row = value as Record<string, unknown>;
          addChild(
            String(
              this.pickFamilyField(row, 'name', 'childName', 'Childs Name', 'Child Name', 'fullName') ||
                ''
            ),
            String(this.pickFamilyField(row, 'grade', 'gradeLevel', 'Grade Level', 'Grade') || ''),
            String(
              this.pickFamilyField(
                row,
                'profilePicture',
                'childProfilePicture',
                'Child Profile Picture'
              ) || ''
            ),
            !!this.pickFamilyField(row, 'Child Verified', 'childVerified', 'isVerified')
          );
        }
        continue;
      }

      const strVal = String(value).trim();
      if (!strVal) continue;

      let index = '';
      const indexedPatterns: RegExp[] = [
        /^Childs?\s*Name\s*(\d+)$/i,
        /^Child\s*Name\s*(\d+)$/i,
        /^childsName(\d+)$/i,
        /^childName(\d+)$/i,
        /^Child\s*(\d+)\s*Name$/i,
      ];
      let matched = false;
      for (const pattern of indexedPatterns) {
        const m = key.match(pattern);
        if (m) {
          index = m[1] || '';
          matched = true;
          break;
        }
      }
      if (!matched || !index) continue;

      addChild(
        strVal,
        this.gradeForIndexedChild(data, index),
        this.photoForIndexedChild(data, index)
      );
    }

    return results;
  }

  async getFamilyChildren(familyName: string, parentUid?: string): Promise<FamilyChildRecord[]> {
    try {
      const familiesCollection = collection(this.firestore, 'List Of Families');
      const docById = new Map<string, Record<string, unknown>>();

      const addSnapshot = (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => {
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const docFamily = String(data['Family Name'] || data['familyName'] || '').trim();
          if (familyName && docFamily && docFamily !== familyName) return;
          docById.set(docSnap.id, data);
        });
      };

      let q = query(familiesCollection, where('Family Name', '==', familyName));
      let querySnapshot = await getDocs(q);
      addSnapshot(querySnapshot);

      if (querySnapshot.empty) {
        q = query(familiesCollection, where('familyName', '==', familyName));
        querySnapshot = await getDocs(q);
        addSnapshot(querySnapshot);
      }

      if (parentUid) {
        const uidSnap = await getDocs(
          query(familiesCollection, where('uid', '==', parentUid))
        );
        addSnapshot(uidSnap);
      }

      const children: FamilyChildRecord[] = [];
      const seenNames = new Set<string>();

      for (const data of docById.values()) {
        for (const child of this.extractChildrenFromFamilyDoc(data)) {
          const key = child.name.toLowerCase();
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          children.push(child);
        }
      }

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
