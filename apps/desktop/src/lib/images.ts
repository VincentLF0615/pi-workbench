import type { ImageContent } from "./types";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 20 * 1024 * 1024;
export const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export function imageBytes(image: ImageContent): number {
  return (
    (image.data.length * 3) / 4 -
    (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
  );
}
export function validateImages(images: ImageContent[]): void {
  if (images.length > 32) throw new Error("一次最多发送 32 张图片");
  let total = 0;
  for (const image of images) {
    if (!imageTypes.has(image.mimeType))
      throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
    const size = imageBytes(image);
    if (!size || size > MAX_IMAGE_BYTES)
      throw new Error("图片为空或超过 10 MiB");
    total += size;
  }
  if (total > MAX_IMAGES_BYTES) throw new Error("图片合计不能超过 20 MiB");
}
export async function readImage(file: File): Promise<ImageContent> {
  if (!imageTypes.has(file.type))
    throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error("图片为空或超过 10 MiB");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`));
    reader.onload = () => {
      const data = String(reader.result).split(",", 2)[1];
      if (!data) reject(new Error("图片数据为空"));
      else resolve({ type: "image", data, mimeType: file.type });
    };
    reader.readAsDataURL(file);
  });
}
