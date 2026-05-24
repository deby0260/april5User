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
  private memoryCache = new Map<string, UserRole>();
  private roleFetchPromise: Promise<UserRole | null> | null = null;

  constructor(
    private authService: AuthService,
    private familyService: FamilyService
  ) { }

  private roleCacheKey(uid: string): string {
    return `userRole:${uid}`;
  }

  /** Synchronous read of the last known role for the active user (avoids home UI flicker). */
  getCachedUserRole(): UserRole | null {
    const uid = this.authService.getCurrentUser()?.uid;
    if (!uid) {
      return null;
    }

    const mem = this.memoryCache.get(uid);
    if (mem) {
      return mem;
    }

    try {
      const raw = localStorage.getItem(this.roleCacheKey(uid));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as UserRole;
      if (parsed?.role) {
        this.memoryCache.set(uid, parsed);
        return parsed;
      }
    } catch {
      /* noop */
    }

    return null;
  }

  private saveUserRoleCache(uid: string, role: UserRole): void {
    this.memoryCache.set(uid, role);
    try {
      localStorage.setItem(this.roleCacheKey(uid), JSON.stringify(role));
    } catch {
      /* noop */
    }
  }

  clearUserRoleCache(uid?: string): void {
    const id = uid || this.authService.getCurrentUser()?.uid;
    if (!id) {
      return;
    }
    this.memoryCache.delete(id);
    localStorage.removeItem(this.roleCacheKey(id));
  }

  /**
   * Applies cached role immediately, then refreshes from Firestore in the background.
   */
  applyUserRole(onApply: (role: UserRole) => void): void {
    const cached = this.getCachedUserRole();
    if (cached) {
      onApply(cached);
    }
    void this.getUserRole().then((role) => {
      if (role) {
        onApply(role);
      }
    });
  }

  /** Preload role after login / app resume (no-op when cache is warm). */
  warmUserRoleCache(): Promise<UserRole | null> {
    if (this.getCachedUserRole()) {
      void this.getUserRole();
      return Promise.resolve(this.getCachedUserRole());
    }
    return this.getUserRole();
  }

  async getUserRole(): Promise<UserRole | null> {
    if (this.roleFetchPromise) {
      return this.roleFetchPromise;
    }

    this.roleFetchPromise = this.fetchUserRoleFromNetwork().finally(() => {
      this.roleFetchPromise = null;
    });
    return this.roleFetchPromise;
  }

  private async fetchUserRoleFromNetwork(): Promise<UserRole | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return null;
      }

      const family = await this.familyService.getUserFamily();
      if (!family) {
        this.clearUserRoleCache(currentUser.uid);
        return null;
      }

      const isOriginalCreator = await this.familyService.isOriginalCreator(currentUser.uid, family.name);

      let userRole: 'owner' | 'parent' | 'companion' = 'companion';

      if (isOriginalCreator) {
        userRole = 'owner';
      } else {
        const members = await this.familyService.getFamilyMembers(family.name);
        const userMember = members.find((member) => member.uid === currentUser.uid);
        if (userMember) {
          userRole = userMember.role;
        } else {
          const userFamilyInfo = await this.familyService.getUserFamilyInfo();
          if (userFamilyInfo?.familyRole) {
            userRole = this.normalizeFamilyRole(userFamilyInfo.familyRole);
          }
        }
      }

      const resolved: UserRole = {
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
        canChangeRoles: this.canChangeRoles(userRole),
      };

      this.saveUserRoleCache(currentUser.uid, resolved);
      return resolved;
    } catch {
      return this.getCachedUserRole();
    }
  }

  canUserAccessFromCache(feature: string): boolean | null {
    const userRole = this.getCachedUserRole();
    if (!userRole) {
      return null;
    }
    return this.resolveFeatureAccess(userRole, feature);
  }

  async canUserAccess(feature: string): Promise<boolean> {
    const cached = this.canUserAccessFromCache(feature);
    if (cached !== null) {
      void this.getUserRole();
      return cached;
    }

    const userRole = await this.getUserRole();
    if (!userRole) {
      return false;
    }
    return this.resolveFeatureAccess(userRole, feature);
  }

  private resolveFeatureAccess(userRole: UserRole, feature: string): boolean {
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

  private normalizeFamilyRole(raw: string): 'owner' | 'parent' | 'companion' {
    const role = String(raw || '').trim().toLowerCase();
    if (role === 'parent' || role === 'parents') {
      return 'parent';
    }
    if (role === 'owner') {
      return 'owner';
    }
    if (role === 'member') {
      return 'companion';
    }
    return 'companion';
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
    const cached = this.getCachedUserRole();
    if (cached) {
      void this.getUserRole();
      return cached.role === 'owner';
    }
    const userRole = await this.getUserRole();
    return userRole?.role === 'owner';
  }

  async isParentOrOwner(): Promise<boolean> {
    const cached = this.getCachedUserRole();
    if (cached) {
      void this.getUserRole();
      return ['owner', 'parent'].includes(cached.role);
    }
    const userRole = await this.getUserRole();
    return ['owner', 'parent'].includes(userRole?.role || '');
  }

  async getUserRoleString(): Promise<string> {
    const cached = this.getCachedUserRole();
    if (cached) {
      void this.getUserRole();
      return cached.role;
    }
    const userRole = await this.getUserRole();
    return userRole?.role || 'companion';
  }

  
  async canRemoveMember(memberUID: string, familyName: string): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return false;
      }

      
      const userRole = this.getCachedUserRole() || (await this.getUserRole());
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
      return false;
    }
  }

  
  async canChangeMemberRole(memberUID: string, familyName: string): Promise<boolean> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        return false;
      }

      
      const userRole = this.getCachedUserRole() || (await this.getUserRole());
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
      return false;
    }
  }
}
