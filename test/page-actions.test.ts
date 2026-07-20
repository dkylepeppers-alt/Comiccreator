// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerPageEventListeners, type PageActionDeps } from '../src/js/page-actions.js';

function fire(el: Element, type: string) {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

describe('page-actions delegated dispatch', () => {
  let module: Record<string, any>;
  let deps: { navigate: any; logWarn: any; logError: any };

  // Register once — jsdom's document persists across tests, so per-test
  // registration would stack duplicate listeners. The stable wrapper forwards
  // to the current per-test mocks.
  const stableDeps: PageActionDeps = {
    getPage: () => 'test',
    getModule: (page) => (page === 'test' ? module : undefined),
    navigate: (page, param) => deps.navigate(page, param),
    logWarn: (ctx, msg) => deps.logWarn(ctx, msg),
    logError: (...a: Parameters<PageActionDeps['logError']>) => deps.logError(...a),
  };
  registerPageEventListeners(stableDeps, document);

  beforeEach(() => {
    document.body.innerHTML = '';
    module = {};
    deps = {
      navigate: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    };
  });

  it('dispatches a click data-action with JSON args plus the element', () => {
    module.doThing = vi.fn();
    document.body.innerHTML = '<button data-action="doThing" data-args=\'[3, "abc"]\'>x</button>';
    const btn = document.querySelector('button');
    fire(btn, 'click');
    expect(module.doThing).toHaveBeenCalledWith(3, 'abc', btn);
  });

  it('dispatches with only the element when data-args is absent', () => {
    module.plain = vi.fn();
    document.body.innerHTML = '<button data-action="plain">x</button>';
    const btn = document.querySelector('button');
    fire(btn, 'click');
    expect(module.plain).toHaveBeenCalledWith(btn);
  });

  it('dispatches only the innermost action for nested actionable elements', () => {
    module.open = vi.fn();
    module.remove = vi.fn();
    document.body.innerHTML = `
      <div data-action="open" data-args='["row1"]'>
        <button data-action="remove" data-args='["row1"]'>x</button>
      </div>`;
    fire(document.querySelector('button'), 'click');
    expect(module.remove).toHaveBeenCalledTimes(1);
    expect(module.open).not.toHaveBeenCalled();
  });

  it('does not navigate when clicking an action nested inside a data-navigate element', () => {
    module.remove = vi.fn();
    document.body.innerHTML = `
      <div data-navigate="library" data-param="c1">
        <button data-action="remove" data-args='["c1"]'>x</button>
      </div>`;
    fire(document.querySelector('button'), 'click');
    expect(module.remove).toHaveBeenCalledTimes(1);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('navigates with page and param for data-navigate clicks and prevents the default', () => {
    document.body.innerHTML = '<a href="#" data-navigate="library" data-param="c1"><span>go</span></a>';
    const span = document.querySelector('span');
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    span.dispatchEvent(event);
    expect(deps.navigate).toHaveBeenCalledWith('library', 'c1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('passes null param when data-param is absent', () => {
    document.body.innerHTML = '<button data-navigate="create">go</button>';
    fire(document.querySelector('button'), 'click');
    expect(deps.navigate).toHaveBeenCalledWith('create', null);
  });

  it('dispatches change events via data-action-change with the element appended', () => {
    module.updateTag = vi.fn();
    document.body.innerHTML = '<select data-action-change="updateTag" data-args="[2]"><option>a</option></select>';
    const select = document.querySelector('select');
    fire(select, 'change');
    expect(module.updateTag).toHaveBeenCalledWith(2, select);
  });

  it('dispatches input events via data-action-input with the element appended', () => {
    module.setSearch = vi.fn();
    document.body.innerHTML = '<input data-action-input="setSearch" value="q">';
    const input = document.querySelector('input');
    fire(input, 'input');
    expect(module.setSearch).toHaveBeenCalledWith(input);
  });

  it('does not treat a click as a change/input action', () => {
    module.updateTag = vi.fn();
    document.body.innerHTML = '<select data-action-change="updateTag"><option>a</option></select>';
    fire(document.querySelector('select'), 'click');
    expect(module.updateTag).not.toHaveBeenCalled();
  });

  it('warns without throwing when the action has no handler on the current page', () => {
    document.body.innerHTML = '<button data-action="missing">x</button>';
    fire(document.querySelector('button'), 'click');
    expect(deps.logWarn).toHaveBeenCalledWith('Action dispatch', 'No handler "missing" on page "test"');
  });

  it('logs and skips dispatch on malformed data-args JSON', () => {
    module.doThing = vi.fn();
    document.body.innerHTML = '<button data-action="doThing" data-args="[oops">x</button>';
    fire(document.querySelector('button'), 'click');
    expect(module.doThing).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalled();
  });

  it('logs synchronous handler errors instead of throwing', () => {
    module.boom = vi.fn(() => {
      throw new Error('nope');
    });
    document.body.innerHTML = '<button data-action="boom">x</button>';
    fire(document.querySelector('button'), 'click');
    expect(deps.logError).toHaveBeenCalledWith('Action "boom" (test)', expect.any(Error));
  });

  it('logs rejected promises from async handlers', async () => {
    module.slowBoom = vi.fn(async () => {
      throw new Error('later');
    });
    document.body.innerHTML = '<button data-action="slowBoom">x</button>';
    fire(document.querySelector('button'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.logError).toHaveBeenCalledWith('Action "slowBoom" (test)', expect.any(Error));
  });

  it('ignores clicks on elements with no actionable ancestor', () => {
    module.doThing = vi.fn();
    document.body.innerHTML = '<div><button>x</button></div>';
    fire(document.querySelector('button'), 'click');
    expect(module.doThing).not.toHaveBeenCalled();
    expect(deps.logWarn).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });
});
