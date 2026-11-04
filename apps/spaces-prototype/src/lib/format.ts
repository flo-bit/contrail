export function when(value: string | undefined): string {
  if (!value) return 'Time not set';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time not set';
}
