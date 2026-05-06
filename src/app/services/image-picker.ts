import { Injectable } from '@angular/core';
import { Camera, CameraResultType, CameraSource, Photo } from '@capacitor/camera';
import { ActionSheetController, Platform } from '@ionic/angular';

export interface ImagePickerResult {
  success: boolean;
  imageData?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ImagePickerService {

  constructor(
    private actionSheetController: ActionSheetController,
    private platform: Platform
  ) { }

  async selectImage(): Promise<ImagePickerResult> {
    return new Promise(async (resolve) => {
      try {
        
        const actionSheet = await this.actionSheetController.create({
          header: 'Select Image Source',
          buttons: [
            {
              text: 'Camera',
              icon: 'camera',
              handler: async () => {
                const result = await this.getImage(CameraSource.Camera);
                resolve(result);
              }
            },
            {
              text: 'Gallery',
              icon: 'images',
              handler: async () => {
                const result = await this.getImage(CameraSource.Photos);
                resolve(result);
              }
            },
            {
              text: 'Cancel',
              icon: 'close',
              role: 'cancel',
              handler: () => {
                resolve({ success: false, error: 'Image selection cancelled' });
              }
            }
          ]
        });

        await actionSheet.present();
      } catch (error: any) {
        resolve({ success: false, error: error.message || 'Failed to select image' });
      }
    });
  }

  private async getImage(source: CameraSource): Promise<ImagePickerResult> {
    try {
      const image: Photo = await Camera.getPhoto({
        quality: 70,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: source,
        width: 300,
        height: 300
      });

      if (image.dataUrl) {
        return {
          success: true,
          imageData: image.dataUrl
        };
      } else {
        return {
          success: false,
          error: 'Failed to get image data'
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to capture image'
      };
    }
  }

  async selectImageWeb(): Promise<ImagePickerResult> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      input.onchange = (event: any) => {
        const file = event.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (e: any) => {
            resolve({
              success: true,
              imageData: e.target.result
            });
          };
          reader.onerror = () => {
            resolve({
              success: false,
              error: 'Failed to read image file'
            });
          };
          reader.readAsDataURL(file);
        } else {
          resolve({
            success: false,
            error: 'No file selected'
          });
        }
      };

      input.click();
    });
  }

  async pickImage(): Promise<ImagePickerResult> {
    if (this.platform.is('capacitor')) {
      
      return this.selectImage();
    } else {
      return this.selectImageWeb();
    }
  }

  validateImageSize(imageData: string, maxSizeKB: number = 500): boolean {
    try {
      const sizeInBytes = (imageData.length * 3) / 4;
      const sizeInKB = sizeInBytes / 1024;
      return sizeInKB <= maxSizeKB;
    } catch (error) {
      return false;
    }
  }

  async compressImage(imageData: string, quality: number = 0.7): Promise<string> {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      img.onload = () => {
        canvas.width = 300;
        canvas.height = 300;

        ctx?.drawImage(img, 0, 0, 300, 300);
        const compressedData = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedData);
      };

      img.src = imageData;
    });
  }
}
