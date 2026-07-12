import { html } from '../dom.js';

export function Filters({ category, setCategory, categories, t, mistakesCount, dueCount, drillCount, land, hardestCount }) {
  return html`
    <div class="controls">
      <select class="select" value=${category} onChange=${(e) => setCategory(e.target.value)}>
        <option value="all">${t.allCategories}</option>
        ${categories.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
        <option value="land">${t.landOnly(land)}</option>
        <option value="mistakes">${t.mistakesFilter(mistakesCount)}</option>
        <option value="due">${t.dueFilter(dueCount)}</option>
        ${drillCount > 0 && html`<option value="drill">${t.drillFilter(drillCount)}</option>`}
        ${hardestCount > 0 && html`<option value="hardest">${t.hardestFilter(hardestCount)}</option>`}
      </select>
    </div>`;
}
