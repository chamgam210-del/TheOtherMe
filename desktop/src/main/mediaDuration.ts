import { openSync, readSync, closeSync, statSync } from "node:fs";

/** Duration of a WAV file from its header, or an estimate (assuming ~128 kbps) for compressed formats. */
export function mediaDuration(file: string): { seconds: number; estimated: boolean } {
  const size = statSync(file).size;
  if (/\.wav$/i.test(file)) {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(Math.min(size, 4096));
      readSync(fd, head, 0, head.length, 0);
      if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
        let offset = 12;
        let byteRate = 0;
        while (offset + 8 <= head.length) {
          const id = head.toString("ascii", offset, offset + 4);
          const len = head.readUInt32LE(offset + 4);
          if (id === "fmt " && offset + 20 <= head.length) byteRate = head.readUInt32LE(offset + 16);
          if (id === "data") {
            const bytes = Math.min(len, size - (offset + 8)) || size - (offset + 8);
            if (byteRate > 0) return { seconds: Math.round((bytes / byteRate) * 10) / 10, estimated: false };
            break;
          }
          offset += 8 + len + (len % 2);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  return { seconds: Math.round((size / 16000) * 10) / 10, estimated: true };
}
