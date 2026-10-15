export default function Loading() {
  return (
    <main
      className="flex flex-1 items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm opacity-70">Loading…</p>
    </main>
  );
}
