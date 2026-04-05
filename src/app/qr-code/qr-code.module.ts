import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';

import { IonicModule } from '@ionic/angular';

import { QrCodePageRoutingModule } from './qr-code-routing.module';
import { ComponentsModule } from '../components/components.module';

import { QrCodePage } from './qr-code.page';

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    HttpClientModule,
    ComponentsModule,
    QrCodePageRoutingModule
  ],
  declarations: [QrCodePage]
})
export class QrCodePageModule {}
