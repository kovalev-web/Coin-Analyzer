// Re-render when the vanilla side emits one of these events (src/events.js)
import * as React from 'react';
import { on, off } from '../../events.js';

export function useEvents(names) {
  const [, bump] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    names.forEach((n) => on(n, bump));
    return () => names.forEach((n) => off(n, bump));
  }, [names.join('|')]);
}
