import { useSyncExternalStore } from "react";

// False during SSR and the first hydration render, true after.
// The warning-free way to render something only on the client so
// server HTML and the first client pass stay identical.
const noopSubscribe = () => () => {};

export function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
