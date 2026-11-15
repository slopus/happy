import type { ReactNode } from "react";
import { Component, createContext } from "react";

/** The host's translated "couldn't be shown" title, for the page and for each section. */
export const ErrorTitle = createContext("This page couldn't be shown.");

export function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="rk-error" role="alert">
      <p className="rk-error-title">{title}</p>
      <pre>{message}</pre>
    </div>
  );
}

/** Contains a render error, so one broken section leaves the rest of the page readable. */
export class ErrorBoundary extends Component<{ children?: ReactNode }, { message: string | null }> {
  static override contextType = ErrorTitle;
  declare context: string;
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.message === null ? (
      this.props.children
    ) : (
      <ErrorPanel title={this.context} message={this.state.message} />
    );
  }
}
