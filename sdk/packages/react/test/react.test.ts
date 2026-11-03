// T-40: @replayd/react — root error handler + ErrorBoundary.
import { describe, expect, it, vi } from 'vitest';

const cap = vi.fn();
vi.mock('@replayd/core', () => ({ captureException: (...a: unknown[]) => cap(...a) }));

describe('@replayd/react', () => {
  it('reactErrorHandler reports with the component stack and calls the callback', async () => {
    const { reactErrorHandler } = await import('../src/index');
    const cb = vi.fn();
    const e = new Error('render failed');
    reactErrorHandler(cb)(e, { componentStack: '\n    at OrderPanel\n    at App' });
    expect(cap).toHaveBeenCalledWith(e, { source: 'react', ctx: { componentStack: '\n    at OrderPanel\n    at App' } });
    expect(cb).toHaveBeenCalledWith(e, { componentStack: '\n    at OrderPanel\n    at App' });
  });

  it('ErrorBoundary captures, renders the fallback and resets', async () => {
    const { ErrorBoundary } = await import('../src/index');
    const onError = vi.fn();
    const b = new ErrorBoundary({ children: 'ok', fallback: (err: unknown) => `failed: ${(err as Error).message}`, onError });
    expect(b.render()).toBe('ok');
    const e = new Error('x');
    b.state = ErrorBoundary.getDerivedStateFromError(e);
    b.componentDidCatch(e, { componentStack: 'at X' });
    expect(cap).toHaveBeenLastCalledWith(e, { source: 'react', ctx: { componentStack: 'at X' } });
    expect(onError).toHaveBeenCalled();
    expect(b.render()).toBe('failed: x');
    const plain = new ErrorBoundary({});
    plain.state = { error: e };
    expect((plain.render() as { type: string }).type).toBe('p');
  });
});
