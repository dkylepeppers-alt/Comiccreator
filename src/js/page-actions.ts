/**
 * Delegated page-event dispatch.
 *
 * Page templates mark interactive elements with data-action (click),
 * data-action-change (change), or data-action-input (input) instead of inline
 * onclick handlers, plus data-navigate="page" (with optional data-param) for
 * plain navigation. The dispatcher resolves data-action names on the current
 * page module and calls them with the JSON-array data-args followed by the
 * matched element. Only the innermost matching element is dispatched, which
 * replaces the old inline event.stopPropagation() pattern for nested actions.
 */

export interface PageActionDeps {
  /** Key of the currently active page (e.g. 'characters'). */
  getPage(): string;
  /** Page module lookup; methods are resolved on the returned object. */
  getModule(page: string): Record<string, unknown> | undefined;
  navigate(page: string, param: string | null): void;
  logWarn(context: string, message: string): void;
  logError(context: string, error: unknown, extraDetails?: string): void;
}

export const ACTION_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ['click', 'data-action'],
  ['change', 'data-action-change'],
  ['input', 'data-action-input'],
];

export function createPageEventDispatcher(deps: PageActionDeps): (attr: string, event: Event) => void {
  return function dispatchPageEvent(attr: string, event: Event): void {
    const origin = event.target as Element | null;
    if (!origin || typeof origin.closest !== 'function') return;
    const selector = attr === 'data-action' ? '[data-action],[data-navigate]' : `[${attr}]`;
    const el = origin.closest(selector) as HTMLElement | null;
    if (!el) return;

    if (attr === 'data-action' && !el.hasAttribute('data-action')) {
      event.preventDefault(); // data-navigate is also used on <a href="#"> links
      deps.navigate(el.getAttribute('data-navigate') as string, el.getAttribute('data-param'));
      return;
    }

    const name = el.getAttribute(attr) as string;
    const page = deps.getPage();
    const fn = deps.getModule(page)?.[name];
    if (typeof fn !== 'function') {
      deps.logWarn('Action dispatch', `No handler "${name}" on page "${page}"`);
      return;
    }
    let args: unknown[] = [];
    const rawArgs = el.getAttribute('data-args');
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch (err) {
        deps.logError('Action dispatch', err, `Bad data-args for "${name}": ${rawArgs}`);
        return;
      }
    }
    try {
      const result = fn(...args, el);
      if (result instanceof Promise) {
        result.catch((err) => deps.logError(`Action "${name}" (${page})`, err));
      }
    } catch (err) {
      deps.logError(`Action "${name}" (${page})`, err);
    }
  };
}

/** Attach the three delegated listeners to the document. */
export function registerPageEventListeners(deps: PageActionDeps, doc: Document = document): void {
  const dispatch = createPageEventDispatcher(deps);
  for (const [type, attr] of ACTION_EVENTS) {
    doc.addEventListener(type, (e) => dispatch(attr, e));
  }
}
