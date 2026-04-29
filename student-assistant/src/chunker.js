export function chunkText(text, chunkSize = 400, overlap = 50) {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.length <= chunkSize) return [trimmed];

  const chunks = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = start + chunkSize;

    if (end < trimmed.length) {
      const searchZone = trimmed.slice(Math.max(start, end - 80), end);
      const sentenceEnd = Math.max(
        searchZone.lastIndexOf('. '),
        searchZone.lastIndexOf('? '),
        searchZone.lastIndexOf('! '),
        searchZone.lastIndexOf('\n')
      );
      if (sentenceEnd !== -1) {
        end = Math.max(start, end - 80) + sentenceEnd + 1;
      }
    }

    const chunk = trimmed.slice(start, end).trim();

    if (chunk.length >= 100) {
      chunks.push(chunk);
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1] += ' ' + chunk;
    }

    start += chunkSize - overlap;
  }

  return chunks;
}

export function estimateChunkCount(text, chunkSize = 400, overlap = 50) {
  if (!text || text.trim().length <= chunkSize) return 1;
  return Math.ceil((text.trim().length - overlap) / (chunkSize - overlap));
}