import { Observable,merge } from 'rxjs';
import { debounceTime,distinctUntilChanged,filter,map,tap } from 'rxjs/operators';

import {
buildControlsForm,
filtersFromForm,
formFromGlobal,
sameControls,
type ControlsValue,
} from '../chrome/controls-form';
import type { Command } from './commands';

type ControlsForm = ReturnType<typeof buildControlsForm>;

export function controlCommands(form: ControlsForm): Observable<Command> {
  const filters = form.controls.filters.valueChanges;
  const numeric = form.controls.numeric.valueChanges;
  const createdFrom = form.controls.createdFrom.valueChanges;
  const createdTo = form.controls.createdTo.valueChanges;

  return merge(
    form.controls.modality.valueChanges.pipe(map((modality): Command => ({ t: 'setModality', modality }))),
    form.controls.view.valueChanges.pipe(map((view): Command => ({ t: 'setView', view }))),
    merge(filters, numeric, createdFrom, createdTo).pipe(
      debounceTime(150),
      map((): Command => ({ t: 'setFilters', filters: filtersFromForm(form.getRawValue()) })),
    ),
  );
}

export function synchronizeControls(
  form: ControlsForm,
  global$: Observable<Parameters<typeof formFromGlobal>[0]>,
): Observable<ControlsValue> {
  return global$.pipe(
    distinctUntilChanged(),
    map((global) => formFromGlobal(global)),
    filter((wanted) => !sameControls(wanted, form.getRawValue() as ControlsValue)),
    tap((wanted) => form.setValue(wanted, { emitEvent: false })),
  );
}
