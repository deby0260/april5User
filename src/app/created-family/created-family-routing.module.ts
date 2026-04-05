import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { CreatedFamilyPage } from './created-family.page';

const routes: Routes = [
  {
    path: '',
    component: CreatedFamilyPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class CreatedFamilyPageRoutingModule {}
