import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';
import { ComponentsModule } from '../components/components.module';

import { CreatedFamilyPageRoutingModule } from './created-family-routing.module';

import { CreatedFamilyPage } from './created-family.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    CreatedFamilyPageRoutingModule,
    ComponentsModule
  ],
  declarations: [CreatedFamilyPage]
})
export class CreatedFamilyPageModule {}
