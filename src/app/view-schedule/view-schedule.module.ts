import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { ViewSchedulePageRoutingModule } from './view-schedule-routing.module';
import { ComponentsModule } from '../components/components.module';

import { ViewSchedulePage } from './view-schedule.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    ComponentsModule,
    ViewSchedulePageRoutingModule
  ],
  declarations: [ViewSchedulePage]
})
export class ViewSchedulePageModule {}
