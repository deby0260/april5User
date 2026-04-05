import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { FamilyService } from '../services/family.service';

@Injectable({
  providedIn: 'root'
})
export class FamilyGuard implements CanActivate {

  constructor(
    private familyService: FamilyService,
    private router: Router
  ) {}

  async canActivate(): Promise<boolean> {
    try {
      console.log('FamilyGuard: Checking if user has family...');
      const hasFamily = await this.familyService.checkUserHasFamily();

      if (hasFamily) {
        console.log('FamilyGuard: User already has a family, redirecting to created-family page');

        this.router.navigate(['/created-family'], { replaceUrl: true });
        return false;
      }

      console.log('FamilyGuard: User does not have a family, allowing access to register-create-family page');

      return true;
    } catch (error) {
      console.error('Error in FamilyGuard:', error);

      return true;
    }
  }
}
