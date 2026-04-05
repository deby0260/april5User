import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { NotificationsPageRoutingModule } from './notifications-routing.module';
import { ComponentsModule } from '../components/components.module';

import { NotificationsPage } from './notifications.page';
import { PasswordChangeModalComponent } from './password-change-modal/password-change-modal.component';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    NotificationsPageRoutingModule,
    ComponentsModule
  ],
  declarations: [NotificationsPage, PasswordChangeModalComponent]
})
export class NotificationsPageModule {}
