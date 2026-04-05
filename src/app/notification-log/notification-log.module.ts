import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { NotificationLogPageRoutingModule } from './notification-log-routing.module';
import { ComponentsModule } from '../components/components.module';

import { NotificationLogPage } from './notification-log.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    ComponentsModule,
    NotificationLogPageRoutingModule
  ],
  declarations: [NotificationLogPage]
})
export class NotificationLogPageModule {}
