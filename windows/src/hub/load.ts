/** A failed native read is not evidence of empty history or default settings.
 * Retry brief startup IPC failures, then let the page offer an explicit retry. */
export async function loadSaved<T>(read: () => Promise<T | null>,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 150)),
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const value = await read();
      if (value !== null && value !== undefined) return value;
    } catch { /* A transient IPC failure gets the same bounded retry. */ }
    if (attempt < 4) await wait();
  }
  throw new Error("Saved data could not be loaded");
}
