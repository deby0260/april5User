import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';
import { ComponentsModule } from '../components/components.module';

import { CreatingFamilyPageRoutingModule } from './creating-family-routing.module';

import { CreatingFamilyPage } from './creating-family.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    CreatingFamilyPageRoutingModule,
    ComponentsModule
  ],
  declarations: [CreatingFamilyPage]
})
export class CreatingFamilyPageModule {}
