import type { IMAGE_MEDIA_TYPES } from "@aso/shared";

export interface ImageInfo {
  mediaType: (typeof IMAGE_MEDIA_TYPES)[number];
  width: number;
  height: number;
}

/**
 * Type and size of an image from its header bytes (PNG, JPEG, GIF, WebP); undefined when the
 * bytes are none of these or the header is cut short. The type comes from the content, never
 * from the file name, so the model is told the truth about what it gets.
 */
export function probeImage(buf: Buffer): ImageInfo | undefined {
  try {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { mediaType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a")) {
      return { mediaType: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
      return webp(buf);
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
  } catch {
    // A header that claims more bytes than the file has (RangeError): not a usable image.
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function webp(buf: Buffer): ImageInfo | undefined {
  const chunk = buf.toString("latin1", 12, 16);
  const size = (width: number, height: number): ImageInfo => ({ mediaType: "image/webp", width, height });
  if (chunk === "VP8 ") return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  if (chunk === "VP8L") {
    const b = buf.subarray(21, 25);
    return size(1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)));
  }
  if (chunk === "VP8X") return size(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
  return undefined;
}

/** Walks the JPEG markers to the first frame header (SOFn), which holds the size. */
function jpeg(buf: Buffer): ImageInfo | undefined {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Markers without a length: TEM and RSTn.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { mediaType: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    if (marker === 0xda || marker === 0xd9) return undefined; // image data or end before any frame header
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}
