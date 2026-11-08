import sharp from "sharp";

/** Longest edge sent to Claude; larger images are downscaled by the API anyway. */
const MAX_EDGE = 1568;
const TILE_OVERLAP = 80;

export interface PreparedImage {
  mediaType: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
}

/**
 * Normalizes screenshots for transcription: fixes orientation, and splits tall full-page captures
 * into overlapping tiles so text stays legible after downscaling.
 */
export async function prepareScreenshot(bytes: Uint8Array): Promise<PreparedImage[]> {
  const oriented = sharp(Buffer.from(bytes)).rotate();
  const { data: base, info } = await oriented.png().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const tileHeight = Math.max(Math.round(width * 1.4), 900);
  const tiles: Array<{ top: number; height: number }> = [];
  if (height <= tileHeight * 1.25) tiles.push({ top: 0, height });
  else {
    for (let top = 0; top < height; top += tileHeight - TILE_OVERLAP) {
      const h = Math.min(tileHeight, height - top);
      if (h < TILE_OVERLAP * 2 && tiles.length) break;
      tiles.push({ top, height: h });
    }
  }
  const out: PreparedImage[] = [];
  for (const tile of tiles) {
    const { data, info: t } = await sharp(base)
      .extract({ left: 0, top: tile.top, width, height: tile.height })
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
    out.push({ mediaType: "image/jpeg", data: data.toString("base64"), width: t.width, height: t.height });
  }
  return out;
}

export function isSupportedImage(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"].includes(mime);
}
