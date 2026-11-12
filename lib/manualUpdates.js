export async function updateRowsOnce(rows, update, onProgress = () => {}) {
  const outcomes = [];
  for (const row of rows) {
    try {
      outcomes.push({ row, result: await update(row.id) });
    } catch (error) {
      outcomes.push({
        row,
        error: error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "Update timed out and may still be processing. Check the row before retrying."
          : error?.message || "Update failed",
      });
    }
    onProgress(outcomes.length, rows.length);
  }
  return outcomes;
}
