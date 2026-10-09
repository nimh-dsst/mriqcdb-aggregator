import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { asColumnId } from '@mriqc/shared';

import type { StudyState } from '../graph/state';
import { UploadDialogComponent } from './upload-dialog';

@Component({ template: '<app-upload-dialog [study]="study()" (chosen)="chosen = $event" />', standalone: true, imports: [UploadDialogComponent] })
class HostComponent {
  study = signal<StudyState>('none');
  chosen?: { file: File; addToAll: boolean };
}

describe('UploadDialogComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('defaults the add-to-all checkbox to checked', () => {
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('renders matched metrics, mappings, and unmatched columns', () => {
    host.study.set({
      status: 'ready', name: 'Example study', rows: 12,
      metrics: [asColumnId('fd_mean'), asColumnId('snr')], totalMetrics: 3,
      ignoredColumns: ['subject_id'], missingMetrics: [asColumnId('cnr')],
      columnMapping: [{ source: 'FD mean', target: 'fd_mean' }],
    });
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Example study');
    expect(text).toContain('12 scans');
    expect(text).toContain('2 of 3 metrics matched');
    expect(text).toContain('fd_mean');
    expect(text).toContain('FD mean → fd_mean');
    expect(fixture.nativeElement.querySelector('[data-testid="study-ignored"]')).toBeTruthy();
    expect(text).toContain('subject_id');
  });

  it('emits the selected file and current checkbox value, then clears the input', () => {
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    const input = fixture.nativeElement.querySelector('[data-testid="study-file"]') as HTMLInputElement;
    const file = new File(['a,b\n1,2'], 'study.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(host.chosen).toEqual({ file, addToAll: false });
    expect(input.value).toBe('');
  });
});
