/**
 * Minimal hook harness: renders one hook inside a throwaway React root so tests
 * exercise real effects, refs, timers, and cleanup without a testing library.
 * `strict` mirrors how the Next.js app router mounts components in development
 * (React Strict Mode), which double-invokes effects on mount.
 */
import { StrictMode, act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export interface HookHarness<T, P> {
  /** Latest value the hook returned. */
  current(): T;
  /** Re-render with new props (flushed inside `act`). */
  setProps(next: P): Promise<void>;
  /** Run an action (click handler, recognition event) inside `act`. */
  perform(action: () => void): Promise<void>;
  /** Advance real timers inside `act` so effect updates are flushed. */
  advance(ms?: number): Promise<void>;
  /** Unmount the tree and run effect cleanup. */
  unmount(): Promise<void>;
}

export interface MountOptions<P> {
  readonly strict?: boolean;
  readonly props: P;
}

/** Mount `useHook` into a detached container and return its live result. */
export async function mountHook<P, T>(
  useHook: (props: P) => T,
  { strict = true, props }: MountOptions<P>,
): Promise<HookHarness<T, P>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const slot: { value: T | null } = { value: null };
  let currentProps = props;
  let unmounted = false;

  function Probe(): ReactNode {
    slot.value = useHook(currentProps);
    return null;
  }

  const tree = strict
    ? createElement(StrictMode, null, createElement(Probe))
    : createElement(Probe);

  await act(async () => {
    root.render(tree);
  });

  return {
    current(): T {
      if (slot.value === null) throw new Error("hook was not rendered");
      return slot.value;
    },
    async setProps(next: P): Promise<void> {
      currentProps = next;
      await act(async () => {
        root.render(
          strict
            ? createElement(StrictMode, null, createElement(Probe))
            : createElement(Probe),
        );
      });
    },
    async perform(action: () => void): Promise<void> {
      await act(async () => {
        action();
      });
    },
    async advance(ms = 0): Promise<void> {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
    async unmount(): Promise<void> {
      if (unmounted) return;
      unmounted = true;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}
