import type { TopLevelSpec } from 'vega-lite';
import { isColumnY, type Panel } from '../../graph/state';
import { withValueAxes } from './value-axis';

/** Count/probability axes have no server bin grid; retain their scale mode. */
export function withCountRange(spec: TopLevelSpec, panel: Panel): TopLevelSpec {
  return isColumnY(panel.y) ? spec : withValueAxes(spec, panel.options);
}
