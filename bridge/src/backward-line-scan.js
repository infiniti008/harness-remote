// Assemble each record once, including records spanning many read chunks.
const READ_BYTES = 64 * 1024;

export async function* scanLinesBackward(handle, { from, budget }) {
  let cursor = from;
  let fragments = [];
  let carriedBytes = 0;

  function assemble(fragment) {
    if (carriedBytes === 0) return fragment;
    return Buffer.concat([fragment, ...fragments.slice().reverse()], fragment.length + carriedBytes);
  }

  while (cursor > 0) {
    const start = Math.max(0, cursor - READ_BYTES);
    const chunk = Buffer.allocUnsafe(cursor - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    budget?.read(bytesRead);
    const data = chunk.subarray(0, bytesRead);
    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index--) {
      if (data[index] !== 0x0a) continue;
      const fragment = data.subarray(index + 1, lineEnd);
      budget?.line(fragment.length + carriedBytes);
      if (fragment.length + carriedBytes > 0) {
        yield { line: assemble(fragment), offset: start + index + 1, chunkEnd: cursor };
      }
      fragments = [];
      carriedBytes = 0;
      lineEnd = index;
    }
    if (start === 0) {
      const fragment = data.subarray(0, lineEnd);
      budget?.line(fragment.length + carriedBytes);
      if (fragment.length + carriedBytes > 0) {
        yield { line: assemble(fragment), offset: 0, chunkEnd: cursor };
      }
    } else if (lineEnd > 0) {
      const fragment = data.subarray(0, lineEnd);
      fragments.push(fragment);
      carriedBytes += fragment.length;
      budget?.line(carriedBytes);
    }
    cursor = start;
  }
}
