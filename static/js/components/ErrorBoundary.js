import { React, html } from '../dom.js';
import { exportProgress } from '../store.js';

// A render crash must never trap a user's local progress — offer a reload
// and a one-tap export of everything localStorage remembers about them.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return html`
      <div class="app">
        <div class="boot">
          <p>Something went wrong. Your progress is safe on this device.</p>
          <button class="btn" onClick=${() => location.reload()}>Reload</button>
          <button class="btn ghost" onClick=${exportProgress}>Export progress</button>
        </div>
      </div>`;
  }
}
