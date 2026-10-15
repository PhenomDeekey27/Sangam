"use client";

import { useEffect } from "react";

export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm opacity-70">The page could not be displayed.</p>
      <button
        type="button"
        onClick={() => retry()}
        className="min-h-11 rounded border border-current px-4 py-2 text-sm"
      >
        Try again
      </button>
    </main>
  );
}
