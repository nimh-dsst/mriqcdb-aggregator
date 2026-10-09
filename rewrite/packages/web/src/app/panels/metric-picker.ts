import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { MetricDef } from '@mriqc/shared';

interface MetricSubgroup {
  name: string | null;
  metrics: MetricDef[];
}

interface MetricGroup {
  family: string;
  subgroups: MetricSubgroup[];
}

@Component({
  selector: 'app-metric-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex min-w-0 flex-col gap-2 bg-surface text-ink">
      <label class="sr-only" [for]="searchInputId">Search metrics</label>
      <input
        [id]="searchInputId"
        type="search"
        aria-label="Search metrics"
        [value]="search()"
        (input)="updateSearch($event)"
        class="w-full rounded border border-border bg-surface px-2 py-1 text-control text-ink outline-none focus:ring-2 focus:ring-current"
        placeholder="Search metrics"
      />

      <div class="max-h-[240px] overflow-y-auto">
        @if (groups().length === 0) {
          <p class="px-2 py-3 text-caption text-ink-2">No metrics match your search.</p>
        } @else {
          @for (group of groups(); track group.family) {
            <section [attr.aria-labelledby]="familyHeadingId(group.family)">
              <h3 [id]="familyHeadingId(group.family)" class="px-2 pt-2 text-caption font-semibold text-ink-2">
                {{ group.family }}
              </h3>

              @for (subgroup of group.subgroups; track subgroup.name ?? 'uncategorized') {
                @if (subgroup.name) {
                  <h4 class="px-2 pt-2 text-caption font-semibold text-ink-2">{{ subgroup.name }}</h4>
                }
                <div class="flex flex-col">
                  @for (metric of subgroup.metrics; track metric.id) {
                    <button
                      type="button"
                      class="flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-left text-control hover:bg-surface/80 disabled:cursor-not-allowed disabled:opacity-50"
                      [attr.aria-pressed]="selected() === metric.id"
                      [disabled]="isDisabled(metric.id)"
                      (click)="pick(metric.id)"
                    >
                      <span class="min-w-0 whitespace-normal break-words" [attr.title]="metric.label">{{ metric.label }}</span>
                      @if (metric.shortLabel) {
                        <span class="shrink-0 text-caption text-ink-2">{{ metric.shortLabel }}</span>
                      }
                    </button>
                  }
                </div>
              }
            </section>
          }
        }
      </div>
    </div>
  `,
})
export class MetricPicker {
  private static nextInstanceId = 0;

  readonly instanceId = MetricPicker.nextInstanceId++;
  readonly searchInputId = `metric-picker-search-${this.instanceId}`;
  readonly metrics = input<readonly MetricDef[]>([]);
  readonly disabledMetrics = input<readonly string[]>([]);
  readonly selected = input<string | null>(null);
  readonly picked = output<string>();

  readonly search = signal('');

  readonly groups = computed<MetricGroup[]>(() => {
    const query = this.search().trim().toLocaleLowerCase();
    const grouped = new Map<string, MetricGroup>();

    for (const metric of this.metrics()) {
      if (query && !this.searchableText(metric).includes(query)) {
        continue;
      }

      let group = grouped.get(metric.family);
      if (!group) {
        group = { family: metric.family, subgroups: [] };
        grouped.set(metric.family, group);
      }

      const subgroupName = metric.subfamily ?? null;
      let subgroup = group.subgroups.find((candidate) => candidate.name === subgroupName);
      if (!subgroup) {
        subgroup = { name: subgroupName, metrics: [] };
        group.subgroups.push(subgroup);
      }
      subgroup.metrics.push(metric);
    }

    return [...grouped.values()];
  });

  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  familyHeadingId(family: string): string {
    return `metric-picker-${this.instanceId}-family-${family.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  isDisabled(metricId: string): boolean {
    return this.disabledMetrics().includes(metricId);
  }

  pick(metricId: string): void {
    if (!this.isDisabled(metricId)) {
      this.picked.emit(metricId);
    }
  }

  private searchableText(metric: MetricDef): string {
    return [metric.label, metric.shortLabel, metric.id, metric.family, metric.subfamily]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLocaleLowerCase();
  }
}
