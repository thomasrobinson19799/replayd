/**
 * @replayd/react (PRD §4.1).
 * - `reactErrorHandler(cb?)`: for React 19 `createRoot(el, { onUncaughtError, onCaughtError, onRecoverableError })`;
 *   reports with source `react` and the component stack, then calls `cb`.
 * - `<ErrorBoundary fallback={…} onError={…}>`: React 18/19 boundary (no JSX runtime needed).
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';
import { captureException } from '@replayd/core';

const report = (error: unknown, info?: { componentStack?: string | null }) =>
  captureException(error, { source: 'react', ctx: { componentStack: info?.componentStack?.slice(0, 2000) } });

export function reactErrorHandler(cb?: (error: unknown, info: ErrorInfo) => void): (error: unknown, info: ErrorInfo) => void {
  return (error, info) => {
    report(error, info);
    cb?.(error, info);
  };
}

export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** rendered after an error; a function gets the error and a reset callback */
  fallback?: ReactNode | ((error: unknown, reset: () => void) => ReactNode);
  onError?: (error: unknown, info: ErrorInfo) => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('unknown') };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    report(error, info);
    this.props.onError?.(error, info);
  }
  reset = () => this.setState({ error: null });
  render() {
    const { error } = this.state, f = this.props.fallback;
    if (error == null) return this.props.children ?? null;
    return typeof f == 'function' ? f(error, this.reset) : (f ?? createElement('p', null, 'Something went wrong.'));
  }
}
