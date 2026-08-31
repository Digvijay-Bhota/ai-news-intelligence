export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Unknown time';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const diffInSeconds = (timestamp * 1000 - Date.now()) / 1000;

  if (Math.abs(diffInSeconds) < 60) return 'Just now';
  const diffInMinutes = diffInSeconds / 60;
  if (Math.abs(diffInMinutes) < 60) return rtf.format(Math.round(diffInMinutes), 'minute');
  const diffInHours = diffInMinutes / 60;
  if (Math.abs(diffInHours) < 24) return rtf.format(Math.round(diffInHours), 'hour');
  const diffInDays = diffInHours / 24;
  if (Math.abs(diffInDays) < 30) return rtf.format(Math.round(diffInDays), 'day');
  const diffInMonths = diffInDays / 30;
  if (Math.abs(diffInMonths) < 12) return rtf.format(Math.round(diffInMonths), 'month');

  return rtf.format(Math.round(diffInMonths / 12), 'year');
}

export function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}
