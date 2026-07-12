// Single source of truth for the vendored UMD globals (React, ReactDOM, htm)
// — every component module imports from here instead of touching window.*.
// `React` must be re-bound to a module-local const: `export { React }` can't
// reference the bare global, only a binding declared in this module.
const React = window.React;
export { React };
export const { useState, useEffect, useMemo, useCallback, useRef } = React;
export const html = htm.bind(React.createElement);
