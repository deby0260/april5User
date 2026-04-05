import { TestBed } from '@angular/core/testing';

import { ImagePicker } from './image-picker';

describe('ImagePicker', () => {
  let service: ImagePicker;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ImagePicker);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
