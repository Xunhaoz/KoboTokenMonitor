// Approved palette anchors at 0%, 25%, 50%, 75%, and 100% usage.
const palette = ["#16A34A", "#84B82C", "#D4A017", "#EA771C", "#DC2626"];

export function usageColor(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;

  const position = Math.min(100, Math.max(0, value)) / 25;
  const index = Math.min(Math.floor(position), palette.length - 2);
  const fraction = position - index;
  const channels = [1, 3, 5].map((offset) => {
    const start = parseInt(palette[index].slice(offset, offset + 2), 16);
    const end = parseInt(palette[index + 1].slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * fraction)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
