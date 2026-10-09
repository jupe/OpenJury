const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const SANITIZATION_ERROR =
  "Unable to remove camera and location metadata from this image. Try saving it as JPEG, PNG, or WebP, then upload it again.";

async function loadImageElement(file: File): Promise<HTMLImageElement> {
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(SANITIZATION_ERROR));
      image.src = imageUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export async function sanitizeImage(file: File): Promise<File> {
  let bitmap: ImageBitmap | undefined;
  try {
    if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(file);
  } catch {
    // Some browsers can decode an image element even when createImageBitmap cannot.
  }

  let image: CanvasImageSource;
  let width: number;
  let height: number;
  if (bitmap) {
    image = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } else {
    const decoded = await loadImageElement(file);
    image = decoded;
    width = decoded.naturalWidth;
    height = decoded.naturalHeight;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context || width < 1 || height < 1) throw new Error(SANITIZATION_ERROR);
    context.drawImage(image, 0, 0);

    const outputType = file.type === "image/heic" || file.type === "image/heif" ? "image/jpeg" : file.type;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error(SANITIZATION_ERROR)),
        outputType,
        0.95,
      );
    });
    const extension = IMAGE_EXTENSIONS.get(blob.type);
    if (!extension) throw new Error(SANITIZATION_ERROR);

    const name = `${file.name.replace(/\.[^.]+$/, "") || "image"}.${extension}`;
    return new File([blob], name, { type: blob.type });
  } finally {
    bitmap?.close();
  }
}
