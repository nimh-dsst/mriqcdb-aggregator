import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Graph } from '../loop/graph';
import { ThemeToggle } from '../chrome/theme-toggle';
import { uploadDateLabel } from '../chrome/top-bar';
import { CATALOG_KEY } from '../slices/history/results';

@Component({
  selector: 'app-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, ThemeToggle],
  templateUrl: './about.html',
  styles: `
    :host {
      display: block;
      max-width: 72ch;
      margin: auto;
      padding: 24px 16px 48px;
    }
    section {
      margin-top: 32px;
      scroll-margin-top: 24px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    h3 {
      font-size: 16px;
      font-weight: 600;
      margin: 16px 0 8px;
    }
    p + p,
    ul {
      margin-top: 12px;
    }
    p,
    li {
      line-height: 1.65;
    }
    ul {
      padding-left: 24px;
      list-style: disc;
    }
    li + li {
      margin-top: 8px;
    }
    a {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th,
    td {
      padding: 8px;
      border-bottom: 1px solid var(--border);
      text-align: right;
    }
    th:first-child,
    td:first-child {
      text-align: left;
    }
    th {
      color: var(--ink-2);
      font-weight: 600;
    }
  `,
})
export class About {
  private readonly graph = inject(Graph);
  protected readonly data = toSignal(this.graph.about$);
  protected readonly dateLabel = uploadDateLabel;
  protected retry(): void {
    this.graph.dispatch({ t: 'retryKey', key: CATALOG_KEY });
  }
}
