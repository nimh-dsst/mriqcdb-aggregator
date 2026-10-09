import { tableFromArrays, tableToIPC, tableFromIPC } from 'apache-arrow';
import { BehaviorSubject, lastValueFrom, toArray } from 'rxjs';
import { asColumnId } from '@mriqc/shared';
import { exportRows, runExportEffects, tableCsv } from './export';
import { initialState, reduce } from '../slices/reducer';
import type { Command } from '../slices/commands';
import type { ExportRequest } from '../graph/state';

const request: ExportRequest={modality:'bold',view:'raw',filters:[],selections:[],columns:[asColumnId('id')],format:'arrow'};
const bytes=tableToIPC(tableFromArrays({id:['one','two','three'],value:[1,2,3]}),'stream');
function response() {
  return new Response(new ReadableStream({start(controller) {
    controller.enqueue(bytes.slice(0,47)); controller.enqueue(bytes.slice(47)); controller.close();
  }}),{headers:{'Content-Type':'application/vnd.apache.arrow.stream'}});
}
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(blob);});
}

describe('export effect',()=>{
  it('reports streamed rows and finishes with an Arrow Blob containing those rows',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>response());
    const events=await lastValueFrom(exportRows(request,fetcher).pipe(toArray()));
    expect(events[0]).toEqual({t:'exportProgress',rows:3});
    const done=events.at(-1) as Extract<Command,{t:'exportFinished'}>;
    expect(done.rows).toBe(3); expect(done.filename).toBe('mriqc-bold-raw.arrow');
    expect(done.blob?.type).toBe('application/vnd.apache.arrow.stream');
    expect(tableFromIPC(new Uint8Array(await blobBytes(done.blob!))).numRows).toBe(3);
    expect(new URL(String(fetcher.mock.calls[0][0]), 'http://localhost').searchParams.get('columns')).toBe('id');
  });
  it('creates a CSV Blob from the same Arrow stream',async()=>{
    const events=await lastValueFrom(exportRows({...request,format:'csv'},async()=>response()).pipe(toArray()));
    const done=events.at(-1) as Extract<Command,{t:'exportFinished'}>;
    expect(done.rows).toBe(3);expect(done.filename).toMatch(/\.csv$/);
    expect(new TextDecoder().decode(await blobBytes(done.blob!))).toBe('id,value\r\none,1\r\ntwo,2\r\nthree,3\r\n');
  });
  it('quotes CSV commas, quotes, newlines and nulls',()=>{
    const csv=tableCsv(tableFromArrays({value:['a,b','a"b','a\nb',null]}));
    expect(csv).toBe('value\r\n"a,b"\r\n"a""b"\r\n"a\nb"\r\n\r\n');
  });
  it('forwards the server failure message',async()=>{
    const events=await lastValueFrom(exportRows(request,async()=>new Response(JSON.stringify({error:'Export row cap exceeded'}),{status:413})).pipe(toArray()));
    expect(events).toEqual([{t:'exportFailed',error:'Export row cap exceeded'}]);
  });
  it('aborts fetch on cancellation and emits no failure or download',()=>{
    let signal: AbortSignal | null | undefined;
    const events:Command[]=[];
    const state$=new BehaviorSubject(reduce(initialState,{t:'requestExport',columns:request.columns}));
    const subscription=runExportEffects(state$,(_url,options)=>{signal=options?.signal;return new Promise(()=>{});}).subscribe(event=>events.push(event));
    state$.next(reduce(state$.value,{t:'cancelExport'}));
    expect(signal?.aborted).toBe(true);expect(events).toEqual([]);subscription.unsubscribe();
  });
  it('does not restart for progress and snapshots filters and every brush',()=>{
    const scoped={...initialState,selections:[{from:'p1',metric:asColumnId('fd_mean'),range:[0.1,0.5] as [number,number]}]};
    const state$=new BehaviorSubject(reduce(scoped,{t:'requestExport',columns:request.columns}));
    const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(()=>{}));
    const subscription=runExportEffects(state$,fetcher).subscribe();
    state$.next(reduce(state$.value,{t:'exportProgress',rows:2}));
    state$.next(reduce(state$.value,{t:'setFilters',filters:[]}));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('selections=');
    subscription.unsubscribe();
  });
});
