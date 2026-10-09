import { Observable } from 'rxjs';
import { queryKey, type Density2dResult } from '@mriqc/shared';
import type { State } from '../graph/state';
import type { Command } from '../loop/commands';
import { clusterKeys, densityQueries } from '../slices/panels/queries';
import { createKMeansWorker, type KMeansWorkerResponse } from './kmeans';

export function runClusterEffects(states: Observable<State>): Observable<Command> {
  return new Observable(subscriber => {
    const running = new Map<string, Worker>();
    const subscription = states.subscribe(state => {
      const wanted = new Set<string>();
      for (const panel of state.panels) {
        for (const [index, key] of clusterKeys(state, panel).entries()) {
        if (!key || state.dataVersion === null) continue;
        const token = `${state.dataVersion}/${key}`;
        wanted.add(token);
        if (state.datasets[key]?.version === state.dataVersion || running.has(token)) continue;
        const query = densityQueries(state, panel)[index];
        const entry = query ? state.datasets[queryKey(query)] : undefined;
        if (entry?.status !== 'ready' || entry.version !== state.dataVersion) continue;
        const result = entry.result as Density2dResult;
        const version = state.dataVersion;
        try {
          const worker = createKMeansWorker();
          running.set(token, worker);
          worker.onmessage = event => {
            const response = event.data as KMeansWorkerResponse;
            if (!running.has(token)) return;
            worker.terminate(); running.delete(token);
            subscriber.next('error' in response ? { t: 'dataFailed', key, error: response.error } :
              { t: 'dataArrived', key, result: response.result, version });
          };
          worker.onerror = event => {
            worker.terminate(); running.delete(token);
            subscriber.next({ t: 'dataFailed', key, error: event.message });
          };
          worker.postMessage({ id: token, points: result.sample, k: panel.options.k ?? 3, seed: panel.options.seed ?? 42 });
        } catch (error) { subscriber.next({ t: 'dataFailed', key, error: String(error) }); }
        }
      }
      for (const [token, worker] of running) if (!wanted.has(token)) { worker.terminate(); running.delete(token); }
    });
    return () => { subscription.unsubscribe(); for (const worker of running.values()) worker.terminate(); };
  });
}
