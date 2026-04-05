import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { ViewSchedulePage } from './view-schedule.page';

const routes: Routes = [
  {
    path: '',
    component: ViewSchedulePage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class ViewSchedulePageRoutingModule {}
