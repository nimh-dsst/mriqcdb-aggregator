import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { Graph } from '../graph/graph';
import { defaultDashboard, initialState } from '../graph/reducer';
import { FIRST_PAGE } from '../graph/state';
import { ExportDialog } from './export-dialog';
import { exportView } from './export-view';

describe('export dialog',()=>{
  const state={...initialState,panels:defaultDashboard().panels.map(panel=>({...panel,cursors:FIRST_PAGE}))};
  it('defaults to identity, upload time, manufacturer and visible metrics in Arrow format',async()=>{
    const dispatch=vi.fn();
    await TestBed.configureTestingModule({imports:[ExportDialog],providers:[{provide:Graph,useValue:{state$:new BehaviorSubject(state),dispatch}}]}).compileComponents();
    const fixture=TestBed.createComponent(ExportDialog);fixture.detectChanges();
    const element:HTMLElement=fixture.nativeElement;
    const selected=[...element.querySelectorAll<HTMLInputElement>('input:checked')].map(input=>input.dataset['column']);
    expect(selected).toEqual(expect.arrayContaining(['id','created_at','manufacturer',...state.panels.filter(panel=>panel.x!=='created_at').map(panel=>panel.x)]));
    expect(element.querySelector<HTMLSelectElement>('[data-testid="export-format"]')?.value).toBe('arrow');
    element.querySelector<HTMLButtonElement>('[data-testid="export-start"]')!.click();
    expect(dispatch).toHaveBeenCalledWith({t:'requestExport',columns:selected,format:'arrow'});
    fixture.destroy();
  });
  it('excludes the local study and names that limitation',()=>{
    expect(exportView({...state,panels:[{...state.panels[0],cohorts:['current','study']}]}).study).toBe(true);
    expect(exportView(state).groups.some(group=>group.family==='Motion')).toBe(true);
  });
});
