import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, query, where, getDocs, updateDoc, deleteDoc } from '@angular/fire/firestore';
import { AuthService } from '../services/auth';
import { FamilyService, FamilyMember } from '../services/family.service';
import { RoleAccessService } from '../services/role-access.service';
import { LoadingController, ToastController, AlertController } from '@ionic/angular';

interface Child {
  name: string;
  gradeLevel: string;
  profilePicture: string;
  dateCreated: any;
  isVerified: boolean;
}

interface FamilyData {
  familyName: string;
  createdDate: string;
  children: Child[];
  parentName: string;
  members: FamilyMember[];
}

@Component({
  selector: 'app-created-family',
  templateUrl: './created-family.page.html',
  styleUrls: ['./created-family.page.scss'],
  standalone: false
})
export class CreatedFamilyPage implements OnInit {

  familyData: FamilyData = {
    familyName: '',
    createdDate: '',
    children: [],
    parentName: '',
    members: []
  };

  isLoading: boolean = true;
  currentUserRole: string = '';
  canManageFamily: boolean = false;

  constructor(
    private router: Router,
    private firestore: Firestore,
    private authService: AuthService,
    private familyService: FamilyService,
    private roleAccessService: RoleAccessService,
    private loadingController: LoadingController,
    private toastController: ToastController,
    private alertController: AlertController
  ) {}

  async ngOnInit() {
    const hasFamily = await this.familyService.checkUserHasFamily();
    if (!hasFamily) {
      setTimeout(() => this.router.navigate(['/register-create-family']), 100);
      return;
    }

    const userRole = await this.roleAccessService.getUserRole();
    if (userRole) {
      this.currentUserRole = userRole.role;
      this.canManageFamily = userRole.canManageFamily;
    }

    await this.loadFamilyData();
  }

  private pick<T = any>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && v !== '') return v as T;
    }
    return undefined;
  }

  private toJsDate(v: any): Date | null {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  private normalizeRole(r?: string): 'owner' | 'parent' | 'companion' | 'member' {
    const role = (r || '').toLowerCase().trim();
    if (role === 'owner' || role === 'parent' || role === 'companion') return role as any;
    return 'member';
  }

  private roleRank(r?: string): number {
    switch (this.normalizeRole(r)) {
      case 'owner': return 3;
      case 'parent': return 2;
      case 'companion': return 1;
      default: return 0;
    }
  }

  private mergePreferringHigherRole(a: FamilyMember, b: FamilyMember): FamilyMember {
    const merged = { ...a } as Record<string, any>;
    for (const [k, v] of Object.entries(b)) {
      if (v !== undefined && v !== null && v !== '') {
        merged[k] = v;
      }
    }
    const normalizedRole = this.roleRank(a.role) >= this.roleRank(b.role)
      ? this.normalizeRole(a.role)
      : this.normalizeRole(b.role);
    (merged as FamilyMember).role = (normalizedRole === 'member' ? 'companion' : normalizedRole) as 'owner' | 'parent' | 'companion';

    return merged as FamilyMember;
  }

  async loadFamilyData() {
    try {
      this.isLoading = true;
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        this.showToast('User not authenticated');
        return;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        this.showToast('User is not part of any family');
        return;
      }

      const familiesCol = collection(this.firestore, 'List Of Families');
      let q = query(familiesCol, where('Family Name', '==', family.name));
      let snap = await getDocs(q);

      if (snap.empty) {
        q = query(familiesCol, where('familyName', '==', family.name));
        snap = await getDocs(q);
      }

      const children: Child[] = [];
      let effectiveFamilyName = family.name;
      let earliestDate: Date | null = null;
      const membersFromDocs: FamilyMember[] = [];
      let createdDateString = '';

      snap.forEach((d) => {
        const data = d.data();

        const famNameDoc = this.pick(data, 'Family Name', 'familyName');
        if (famNameDoc) effectiveFamilyName = famNameDoc;

        const createdAt = this.toJsDate(this.pick(data, 'Date Created', 'dateCreated'));
        if (createdAt && (!earliestDate || createdAt < earliestDate)) earliestDate = createdAt;

        const childName = this.pick(data, 'Childs Name', 'childsName', 'childName', 'Child Name');
        if (childName) {
          children.push({
            name: childName,
            gradeLevel: this.pick(data, 'Grade Level', 'gradeLevel') || '',
            profilePicture: this.pick(data, 'Child Profile Picture', 'childProfilePicture') || '',
            dateCreated: createdAt,
            isVerified: !!this.pick(data, 'Child Verified', 'childVerified')
          });
        }

        const parentName = this.pick(data, 'Parent Full Name', 'parentFullName', 'nameOfTheCreator');
        const parentEmail = this.pick(data, 'Parent Email', 'parentEmail');
        const parentContact = this.pick(data, 'Parent Contact Number', 'parentContactNumber');
        const parentPhoto = this.pick(data, 'Parent Profile Picture', 'parentProfilePicture');
        const uid = this.pick(data, 'uid');
        const normalizedRole = this.normalizeRole(this.pick(data, 'role'));
        const role = (normalizedRole === 'member' ? 'companion' : normalizedRole) as 'owner' | 'parent' | 'companion';

        if (parentName || parentEmail) {
          membersFromDocs.push({
            id: uid || '',
            uid: uid || '',
            name: parentName || 'Parent',
            email: parentEmail || '',
            contactNumber: parentContact || '',
            profilePicture: parentPhoto || '',
            role,
            joinedDate: createdAt
          });
        }
      });

      const svcMembers = await this.familyService.getFamilyMembers(effectiveFamilyName);

      const mergeMap = new Map<string, FamilyMember>();
      const keyOf = (m: FamilyMember) =>
        m.uid ? `uid:${m.uid}` : m.email ? `email:${m.email}` : Math.random().toString();

      [...svcMembers, ...membersFromDocs].forEach(m => {
        const normalizedRole = this.normalizeRole(m.role);
        const role = (normalizedRole === 'member' ? 'companion' : normalizedRole) as 'owner' | 'parent' | 'companion';
        const norm: FamilyMember = { ...m, role };
        const k = keyOf(norm);
        if (!mergeMap.has(k)) {
          mergeMap.set(k, norm);
        } else {
          const prev = mergeMap.get(k)!;
          mergeMap.set(k, this.mergePreferringHigherRole(prev, norm));
        }
      });

      if (earliestDate) {
        createdDateString = (earliestDate as Date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      }

      this.familyData = {
        familyName: effectiveFamilyName,
        createdDate: createdDateString,
        children,
        parentName: currentUser.fullName || 'Parent',
        members: Array.from(mergeMap.values())
      };

    } catch (error) {
      this.showToast('Error loading family data');
    } finally {
      this.isLoading = false;
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

  getRoleDisplayName(role: string): string {
    return role === 'owner'
      ? 'Owner'
      : role === 'parent'
      ? 'Parent'
      : role === 'companion'
      ? 'Companion'
      : 'Member';
  }

  getRoleColor(role: string): string {
    return role === 'owner'
      ? 'primary'
      : role === 'parent'
      ? 'success'
      : role === 'companion'
      ? 'warning'
      : 'medium';
  }

  isCurrentUser(member: FamilyMember): boolean {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return false;
    return member.uid === currentUser.uid;
  }

  async changeRole(member: FamilyMember) {
    const alert = await this.alertController.create({
      header: `Change Role for ${member.name}`,
      message: `Select a new role for ${member.name}`,
      inputs: [
        {
          name: 'role',
          type: 'radio',
          label: 'Parent',
          value: 'parent',
          checked: member.role === 'parent'
        },
        {
          name: 'role',
          type: 'radio',
          label: 'Companion',
          value: 'companion',
          checked: member.role === 'companion'
        }
      ],
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Change',
          handler: async (data) => {
            if (data && data !== member.role) {
              await this.updateMemberRole(member, data);
            }
          }
        }
      ]
    });
    await alert.present();
  }

  private async updateMemberRole(member: FamilyMember, newRole: string) {
    try {
      const loading = await this.loadingController.create({
        message: 'Updating role...'
      });
      await loading.present();

      const familyName = this.familyData.familyName;
      const membersCol = collection(this.firestore, 'List Of Families');
      let q = query(membersCol, where('Family Name', '==', familyName));
      let snap = await getDocs(q);

      if (snap.empty) {
        q = query(membersCol, where('familyName', '==', familyName));
        snap = await getDocs(q);
      }

      for (const doc of snap.docs) {
        const data = doc.data();
        const docEmail = this.pick(data, 'Parent Email', 'parentEmail');
        const docUid = this.pick(data, 'uid');

        if (docEmail === member.email || docUid === member.uid) {
          await updateDoc(doc.ref, { role: newRole });
        }
      }

      member.role = newRole as 'owner' | 'parent' | 'companion';
      await loading.dismiss();
      await this.showToast(`${member.name}'s role updated to ${newRole}`);
    } catch (error) {
      await this.showToast('Error updating member role');
    }
  }

  async removeMember(member: FamilyMember) {
    const alert = await this.alertController.create({
      header: 'Remove Member',
      message: `Are you sure you want to remove ${member.name} from the family?`,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Remove',
          role: 'destructive',
          handler: async () => {
            await this.performRemoveMember(member);
          }
        }
      ]
    });
    await alert.present();
  }

  private async performRemoveMember(member: FamilyMember) {
    try {
      const loading = await this.loadingController.create({
        message: 'Removing member...'
      });
      await loading.present();

      const familyName = this.familyData.familyName;
      const membersCol = collection(this.firestore, 'List Of Families');
      let q = query(membersCol, where('Family Name', '==', familyName));
      let snap = await getDocs(q);

      if (snap.empty) {
        q = query(membersCol, where('familyName', '==', familyName));
        snap = await getDocs(q);
      }

      for (const doc of snap.docs) {
        const data = doc.data();
        const docEmail = this.pick(data, 'Parent Email', 'parentEmail');
        const docUid = this.pick(data, 'uid');

        if (docEmail === member.email || docUid === member.uid) {
          await deleteDoc(doc.ref);
        }
      }

      this.familyData.members = this.familyData.members.filter(m => m.uid !== member.uid);
      await loading.dismiss();
      await this.showToast(`${member.name} removed from family`);
    } catch (error) {
      await this.showToast('Error removing member');
    }
  }
}
