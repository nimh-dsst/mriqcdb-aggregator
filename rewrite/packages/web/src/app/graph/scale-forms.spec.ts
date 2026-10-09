import { queryKey } from '../api/api';
import { asColumnId } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';
import { INITIAL_STATE } from './state';
import { defaultDashboard, reduce } from './reducer';
import { panelQueries } from './queries';
import { panelView } from '../view/panel-view';

const state = () => reduce(INITIAL_STATE, { t:'hydrate', url:defaultDashboard() });
describe('continuous form query contracts', () => {
  it.each(['band','lines'] as const)('requests metric binned quantiles for %s', form => {
    const s=reduce(state(),{t:'patchPanel',id:'p1',patch:{y:asColumnId('tsnr'),form}});
    const queries=panelQueries(s,s.panels[0]);
    expect(queries[0]).toMatchObject({proc:'binnedSummary',x:'fd_mean',y:'tsnr',bins:40});
    expect(queries.some(q=>q.proc==='density2d')).toBe(false);
  });
  it.each(['heatmap','scatter','hexbin','clusters'] as const)('requests paired upload dates for %s', form => {
    const s=reduce(state(),{t:'patchPanel',id:'p5',patch:{y:asColumnId('tsnr'),form}});
    expect(panelQueries(s,s.panels[4])[0]).toMatchObject({proc:'density2d',x:'created_at',y:'tsnr'});
  });
  it.each(['created_at'] as const)('Table over %s requests rows and counts, never a numeric distribution', x => {
    const s=reduce(state(),{t:'patchPanel',id:'p5',patch:{x:x==='created_at'?x:asColumnId(x),form:'table'}});
    const queries=panelQueries(s,s.panels[4]);
    expect(queries.map(q=>q.proc)).toEqual(['sample','coverage']);
    const sample=queries[0];
    const view=panelView({...s,dataVersion:'v',datasets:{[queryKey(sample)]:{status:'ready',version:'v',result:{rows:[{id:'old',created_at:'2024-01-01'},{id:'new',created_at:'2024-03-01'}],nextCursor:null}}}},'p5');
    if(x==='created_at') expect(view?.table?.rows.map(row=>row['id'])).toEqual(['new','old']);
  });
  it('rejects hidden Table on a categorical quantity', () => {
    const categorical = reduce(state(), { t: 'patchPanel', id: 'p5', patch: { x: asColumnId('manufacturer') } });
    expect(categorical.panels[4].form).toBe('bars');
    expect(reduce(categorical, { t: 'setPanelForm', id: 'p5', form: 'table' })).toBe(categorical);
  });
});
