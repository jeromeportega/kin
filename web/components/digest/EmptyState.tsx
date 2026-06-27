export function EmptyState() {
  return (
    <div role="status" className="flex flex-col items-center justify-center py-16 text-center">
      <h2 className="text-xl font-semibold text-muted-foreground">No digest yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        No emails have been classified in the current window.
      </p>
    </div>
  )
}
