/// <reference lib="webworker" />

import { kmeans, type KMeansWorkerRequest, type KMeansWorkerResponse } from './kmeans';

addEventListener('message', ({ data }: MessageEvent<KMeansWorkerRequest>) => {
  const id = typeof data?.id === 'string' ? data.id : '';
  try {
    if (!Array.isArray(data?.points)) {
      throw new TypeError('points must be an array of [x, y] pairs');
    }
    const response: KMeansWorkerResponse = {
      id,
      result: kmeans(data.points, data.k, data.seed),
    };
    postMessage(response);
  } catch (error) {
    const response: KMeansWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    postMessage(response);
  }
});
