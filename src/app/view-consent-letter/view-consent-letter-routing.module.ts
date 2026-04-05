import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { ViewConsentLetterPage } from './view-consent-letter.page';

const routes: Routes = [
  {
    path: '',
    component: ViewConsentLetterPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class ViewConsentLetterPageRoutingModule {}
