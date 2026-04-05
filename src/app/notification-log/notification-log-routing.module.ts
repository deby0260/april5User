import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

import { NotificationLogPage } from './notification-log.page';

const routes: Routes = [
  {
    path: '',
    component: NotificationLogPage
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class NotificationLogPageRoutingModule {}
