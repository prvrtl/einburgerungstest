import { html } from '../dom.js';

export function Mastery({ rows, onPick, t }) {
  return html`
    <div class="mastery">
      <div class="m-label">${t.mastery}</div>
      ${rows.map((r) => html`
        <button key=${r.key} class="m-row" onClick=${() => onPick(r.key)}>
          <span class="m-name">${r.name}</span>
          <span class="m-count">${r.done}/${r.total}</span>
          <span class="m-bar"><span class=${r.done === r.total ? 'full' : ''} style=${{ width: (r.total ? (100 * r.done) / r.total : 0) + '%' }}></span></span>
        </button>`)}
    </div>`;
}
