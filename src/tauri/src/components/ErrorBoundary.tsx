import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

/** Without this, an uncaught render error anywhere in the tree (a bad field
 *  in local state, a stale data shape, anything) unmounts the entire app —
 *  the window goes blank/stuck with no way back short of relaunching. This
 *  catches it at the shell level and offers a reload instead. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="entry">
          <div className="entry-content">
            <h1>Something went wrong</h1>
            <p className="entry-subhead">{this.state.error.message}</p>
            <button type="button" className="entry-card" onClick={() => window.location.reload()}>
              <span className="entry-card-cta">Reload →</span>
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
