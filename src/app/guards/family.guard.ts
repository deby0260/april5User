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
      const hasFamily = await this.familyService.checkUserHasFamily();

      if (hasFamily) {
        this.router.navigate(['/created-family'], { replaceUrl: true });
        return false;
      }

      return true;
    } catch (error) {
      return true;
    }
  }
}
