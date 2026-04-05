import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { ConsentLetterPage } from './consent-letter.page';

const routes: Routes = [
  {
    path: '',
    component: ConsentLetterPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class ConsentLetterPageRoutingModule {}
