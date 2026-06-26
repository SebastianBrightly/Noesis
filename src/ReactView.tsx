import { App } from "obsidian";
import React from "react";
import { createRoot, Root } from "react-dom/client";

export const ReactView = () => {
  return <h4>Hello, React!</h4>;
};

// App context
export const AppContext = React.createContext<App | undefined>(undefined);

// Event target context
export const EventTargetContext = React.createContext<EventTarget | undefined>(undefined);

/**
 * Returns the Obsidian {@link App} provided by the nearest {@link AppContext}.
 *
 * Use this inside React components and hooks instead of touching the global
 * `app` object. Throws if no provider is in scope so callers fail loud rather
 * than silently picking up the wrong window's app in popouts.
 */
export function useApp(): App {
  const app = React.useContext(AppContext);
  if (!app) {
    throw new Error("useApp() called outside of an <AppContext.Provider>");
  }
  return app;
}

/**
 * Create a React root that always provides the Obsidian {@link App} via
 * {@link AppContext}.
 *
 * Every standalone React root in the plugin (overlays, modals, item views,
 * setting tabs) must use this helper instead of calling `createRoot`
 * directly so descendants can rely on `useApp()` unconditionally. A static
 * Jest guardrail (`createPluginRoot.test.ts`) enforces this rule.
 *
 * The returned object matches React's {@link Root} interface, so callers
 * can treat it as a drop-in replacement.
 */

export function createPluginRoot(container: Element | DocumentFragment, app: App): Root {
  const root = createRoot(container);
  return {
    render(children) {
      root.render(<AppContext.Provider value={app}>{children}</AppContext.Provider>);
    },
    unmount() {
      root.unmount();
    },
  };
}

