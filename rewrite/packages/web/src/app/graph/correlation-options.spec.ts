import { asColumnId } from '@mriqc/shared';
import { correlationMetrics, defaultCorrelationMetrics } from './correlation-options';
import { defaultDashboard, initialState, reduce } from './reducer';
import { decodeUrlState, encodeUrlState, urlState } from './url';

describe('correlation panel settings', () => {
  it('starts with eight cross-family metrics for each modality', () => {
    expect(defaultCorrelationMetrics('bold')).toEqual(['fd_mean','dvars_std','tsnr','snr','efc','fber','gsr_x','aor']);
    for (const modality of ['T1w','T2w'] as const) {
      expect(defaultCorrelationMetrics(modality)).toEqual(['snr_total','cnr','efc','fber','cjv','wm2max','inu_med','qi_1']);
    }
  });
  it('preserves metric chips and the selected coefficient through reducer and URL hydration', () => {
    const initial = reduce(initialState, {t:'hydrate',url:defaultDashboard()});
    const configured = reduce(initial, {t:'patchPanel',id:'p1',patch:{form:'matrix',options:{metrics:[asColumnId('fd_mean'),asColumnId('tsnr')],coefficient:'pearson'}}});
    expect(configured.panels[0].form).toBe('matrix');
    expect(correlationMetrics(configured.panels[0], 'bold')).toEqual(['fd_mean','tsnr']);
    const restored = reduce(initialState, {t:'hydrate',url:decodeUrlState(encodeUrlState(urlState(configured)))!});
    expect(restored.panels[0]).toEqual(configured.panels[0]);
  });
  it('keeps the second metric token independent from its scale and range', () => {
    const initial = reduce(initialState, {t:'hydrate',url:defaultDashboard()});
    const configured = reduce(initial, {t:'patchPanel',id:'p1',patch:{y:asColumnId('tsnr'),form:'heatmap',options:{yScale:'symlog',yRange:[-2,100]}}});
    expect(decodeUrlState(encodeUrlState(urlState(configured)))?.panels[0]).toMatchObject({y:'tsnr',options:{yScale:'symlog',yRange:[-2,100]}});
  });
});
