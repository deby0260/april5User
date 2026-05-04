import { Injectable } from '@angular/core';
import { AuthService } from './auth';
import { FamilyService } from './family.service';

export interface UserRole {
  role: 'owner' | 'parent' | 'companion';
  familyName: string;
  canAccessAnalytics: boolean;
  canAccessConsentLetter: boolean;
  canAccessScheduling: boolean;
  canAccessQRCode: boolean;
  canViewSchedule: boolean;
  canShowConsentLetter: boolean;
  canAccessNotifications: boolean;
  canManageFamily: boolean;
  canRemoveMembers: boolean;
  canChangeRoles: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class RoleAccessService {

  constructor(
    private authService: AuthService,
    private familyService: FamilyService
  ) { }


  async getUserRole(): Promise<UserRole | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return null;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        return null;
      }


      const isOriginalCreator = await this.familyService.isOriginalCreator(currentUser.uid, family.name);

      let userRole: 'owner' | 'parent' | 'companion' = 'companion';

      if (isOriginalCreator) {

        userRole = 'owner';
      } else {
        // First, check the user's familyRole from getUserFamilyInfo (which checks Registerd collection)
        const userFamilyInfo = await this.familyService.getUserFamilyInfo();
        if (userFamilyInfo && userFamilyInfo.familyRole) {
          const role = userFamilyInfo.familyRole.toLowerCase();
          if (role === 'parent' || role === 'parents') {
            userRole = 'parent';
          } else if (role === 'companion') {
            userRole = 'companion';
          } else if (role === 'owner') {
            userRole = 'owner';
          }
          console.log('Role detected from Registerd collection:', userRole);
        } else {
          // Fallback: check List Of Families collection
          const members = await this.familyService.getFamilyMembers(family.name);
          const userMember = members.find(member => member.uid === currentUser.uid);

          if (userMember) {
            userRole = userMember.role;
            console.log('Role detected from List Of Families:', userRole);
          }
        }
      }

      console.log('Final user role:', userRole, 'for family:', family.name);

      return {
        role: userRole,
        familyName: family.name,
        canAccessAnalytics: this.canAccessAnalytics(userRole),
        canAccessConsentLetter: this.canAccessConsentLetter(userRole),
        canAccessScheduling: this.canAccessScheduling(userRole),
        canAccessQRCode: this.canAccessQRCode(userRole),
        canViewSchedule: this.canViewSchedule(userRole),
        canShowConsentLetter: this.canShowConsentLetter(userRole),
        canAccessNotifications: this.canAccessNotifications(userRole),
        canManageFamily: this.canManageFamily(userRole),
        canRemoveMembers: this.canRemoveMembers(userRole),
        canChangeRoles: this.canChangeRoles(userRole)
      };
    } catch (error) {
      console.error('Error getting user role:', error);
      return null;
    }
  }

  
  async canUserAccess(feature: string): Promise<boolean> {
    const userRole = await this.getUserRole();
    if (!userRole) {
      return false;
    }

    switch (feature) {
      case 'analytics':
        return userRole.canAccessAnalytics;
      case 'consent-letter':
        return userRole.canAccessConsentLetter;
      case 'scheduling':
        return userRole.canAccessScheduling;
      case 'qr-code':
        return userRole.canAccessQRCode;
      case 'view-schedule':
        return userRole.canViewSchedule;
      case 'show-consent-letter':
        return userRole.canShowConsentLetter;
      case 'notifications':
        return userRole.canAccessNotifications;
      case 'manage-family':
        return userRole.canManageFamily;
      case 'remove-members':
        return userRole.canRemoveMembers;
      case 'change-roles':
        return userRole.canChangeRoles;
      default:
        return false;
    }
  }

  private canAccessAnalytics(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  private canAccessConsentLetter(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  private canAccessScheduling(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  private canAccessQRCode(role: string): boolean {
    return ['owner', 'parent', 'companion'].includes(role);
  }

  private canViewSchedule(role: string): boolean {
    return ['owner', 'parent', 'companion'].includes(role);
  }

  private canShowConsentLetter(role: string): boolean {
    return ['owner', 'parent', 'companion'].includes(role);
  }

  private canAccessNotifications(role: string): boolean {
    return ['owner', 'parent', 'companion'].includes(role);
  }

  private canManageFamily(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  private canRemoveMembers(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  private canChangeRoles(role: string): boolean {
    return ['owner', 'parent'].includes(role);
  }

  
  getAccessDeniedMessage(feature: string, userRole?: string): string {
    const role = userRole || 'companion';
    
    switch (feature) {
      case 'analytics':
      case 'consent-letter':
      case 'scheduling':
        return `Only family owners and parents can access this feature. Your current role is "${role}". Contact a family owner to upgrade your role.`;
      case 'manage-family':
      case 'remove-members':
      case 'change-roles':
        return `Only family owners and parents can manage family members. Your current role is "${role}".`;
      default:
        return `You don't have permission to access this feature. Your current role is "${role}".`;
    }
  }

  
  async isOwner(): Promise<boolean> {
    const userRole = await this.getUserRole();
    return userRole?.role === 'owner';
  }

  
  async isParentOrOwner(): Promise<boolean> {
    const userRole = await this.getUserRole();
    return ['owner', 'parent'].includes(userRole?.role || '');
  }

  
  async getUserRoleString(): Promise<string> {
    const userRole = await this.getUserRole();
    return userRole?.role || 'companion';
  }

  
  async canRemoveMember(memberUID: string, familyName: string): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return false;
      }

      
      const userRole = await this.getUserRole();
      if (!userRole || !userRole.canRemoveMembers) {
        return false;
      }

      
      if (memberUID === currentUser.uid) {
        return false;
      }

      
      const isOriginalCreator = await this.familyService.isOriginalCreator(memberUID, familyName);
      if (isOriginalCreator) {
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error checking if user can remove member:', error);
      return false;
    }
  }

  
  async canChangeMemberRole(memberUID: string, familyName: string): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return false;
      }

      
      const userRole = await this.getUserRole();
      if (!userRole || !userRole.canChangeRoles) {
        return false;
      }

      
      if (memberUID === currentUser.uid) {
        return false;
      }

      
      const isOriginalCreator = await this.familyService.isOriginalCreator(memberUID, familyName);
      if (isOriginalCreator) {
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error checking if user can change member role:', error);
      return false;
    }
  }
}
