import { createReadStream } from 'node:fs';

export async function* forwardLines(file, { budget } = {}) {
  let fragments = [];
  let carriedBytes = 0;
  let offset = 0;
  for await (const chunk of createReadStream(file)) {
    budget?.read(chunk.length);
    let lineStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue;
      const fragment = chunk.subarray(lineStart, index);
      const length = carriedBytes + fragment.length;
      budget?.line(length);
      const line = carriedBytes > 0 ? Buffer.concat([...fragments, fragment], length) : fragment;
      yield { line, offset };
      offset += length + 1;
      fragments = [];
      carriedBytes = 0;
      lineStart = index + 1;
    }
    if (lineStart < chunk.length) {
      const fragment = chunk.subarray(lineStart);
      fragments.push(fragment);
      carriedBytes += fragment.length;
      budget?.line(carriedBytes);
    }
  }
  if (carriedBytes > 0) {
    const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, carriedBytes);
    yield { line, offset };
  }
}
