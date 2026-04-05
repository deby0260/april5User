import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { CreatingFamilyPage } from './creating-family.page';

const routes: Routes = [
  {
    path: '',
    component: CreatingFamilyPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class CreatingFamilyPageRoutingModule {}
