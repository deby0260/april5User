import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { SchedulingPageRoutingModule } from './scheduling-routing.module';
import { ComponentsModule } from '../components/components.module';

import { SchedulingPage } from './scheduling.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    ComponentsModule,
    SchedulingPageRoutingModule
  ],
  declarations: [SchedulingPage]
})
export class SchedulingPageModule {}
