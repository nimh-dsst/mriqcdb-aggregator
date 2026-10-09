import { TestBed } from '@angular/core/testing';
import { asColumnId } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';
import { defaultForm, validForm, FORM_INFO, formsFor } from '../graph/panel-shapes';
import { defaultPanelOptions, type Form } from '../graph/state';
import { FormGlyph } from './form-glyphs';

describe('mark forms', () => {
  it('defaults continuous axes to Histogram, pairs to Heatmap except time pairs to Band, and categories to Bars', () => {
    expect(defaultForm(asColumnId('snr'), null)).toBe('histogram');
    expect(defaultForm('created_at', null)).toBe('histogram');
    expect(defaultForm(asColumnId('snr'), asColumnId('fd_mean'))).toBe('heatmap');
    expect(defaultForm('created_at', asColumnId('fd_mean'))).toBe('band');
    expect(defaultForm(asColumnId('manufacturer'), null)).toBe('bars');
  });
  it.each([
    [asColumnId('snr'), null, ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table'], ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table']],
    ['created_at', null, ['histogram', 'line', 'area', 'density', 'ecdf', 'box', 'table'], ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table']],
    ['created_at', asColumnId('fd_mean'), ['heatmap', 'scatter', 'hexbin', 'clusters', 'band', 'lines'], ['Heatmap', 'Scatter', 'Hexbin', 'Clusters', 'Band', 'Lines']],
    [asColumnId('snr'), asColumnId('fd_mean'), ['heatmap', 'scatter', 'hexbin', 'clusters', 'band', 'lines'], ['Heatmap', 'Scatter', 'Hexbin', 'Clusters', 'Band', 'Lines']],
    [asColumnId('manufacturer'), null, ['bars', 'share'], ['Bars', 'Share']],
    [[asColumnId('snr'), asColumnId('fd_mean')], null, ['matrix'], ['Matrix']],
  ] as const)('has the exact ordered row and default for %s / %s', (x, y, ids, names) => {
    const forms = formsFor(x, y);
    expect(forms).toEqual(ids);
    expect(forms[0]).toBe(ids[0]);
    expect(forms.map(form => FORM_INFO[form].label)).toEqual(names);
  });

  it.each([
    ['stackedBar', 'bars'], ['medianBand', 'band'], ['density2d', 'heatmap'],
    ['correlation', 'matrix'], ['categoryCounts', 'bars'], ['categoryShare', 'share'],
    ['facetedHistogram', 'histogram'], ['overlaidEcdf', 'ecdf'],
  ] as const)('does not offer obsolete form %s', (old, _current) => {
    expect(FORM_INFO).not.toHaveProperty(old);
    const panel = { id: 'p1', x: asColumnId('snr'), y: null, series: [],
      form: old as Form, options: defaultPanelOptions(), cursors: [null] };
    expect(validForm(panel).form).toBe('histogram');
  });

  it.each(Object.keys(FORM_INFO) as Form[])('renders exactly one inline SVG for %s', form => {
    TestBed.configureTestingModule({ imports: [FormGlyph] });
    const fixture = TestBed.createComponent(FormGlyph);
    fixture.componentRef.setInput('form', form);
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelectorAll('svg');
    expect(svg).toHaveLength(1);
    expect(svg[0].getAttribute('width')).toBe('20');
    expect(svg[0].getAttribute('height')).toBe('14');
    expect(svg[0].querySelector('path').getAttribute('d')).toBeTruthy();
  });
});
