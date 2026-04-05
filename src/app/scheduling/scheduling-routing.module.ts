import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { SchedulingPage } from './scheduling.page';

const routes: Routes = [
  {
    path: '',
    component: SchedulingPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class SchedulingPageRoutingModule {}
