import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";

/**
 * What a guard shows in place of the views that threw, with a way to draw them again. A component,
 * drawn as an element: called as a function, the hooks the React Compiler gives it would throw.
 */
export type CrashFallback = ComponentType<{
  readonly error: unknown;
  readonly componentStack: string | undefined;
  readonly retry: () => void;
}>;

interface CrashGuardProps {
  readonly fallback: CrashFallback;
  /** Drawing something else here (another thread, another tab) clears the crash. */
  readonly resetKey?: unknown;
  readonly children: ReactNode;
}

interface CrashGuardState {
  readonly error?: { readonly value: unknown } | undefined;
  readonly componentStack?: string | undefined;
  readonly resetKey?: unknown;
}

/**
 * Keeps an error thrown while drawing the views inside it from blanking the whole window: they give
 * way to `fallback` until retried, or until `resetKey` changes. React reports the error itself
 * (main.tsx's root options); a class is still the only way React lets a component catch one.
 */
export class CrashGuard extends Component<CrashGuardProps, CrashGuardState> {
  override state: CrashGuardState = { resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<CrashGuardState> {
    return { error: { value: error } };
  }

  static getDerivedStateFromProps(
    props: CrashGuardProps,
    state: CrashGuardState,
  ): Partial<CrashGuardState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { error: undefined, componentStack: undefined, resetKey: props.resetKey };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  readonly retry = () => this.setState({ error: undefined, componentStack: undefined });

  override render() {
    const { error, componentStack } = this.state;
    if (error === undefined) return this.props.children;
    const Fallback = this.props.fallback;
    return <Fallback error={error.value} componentStack={componentStack} retry={this.retry} />;
  }
}
