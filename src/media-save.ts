export type CapturedMedia = {
  blob: Blob;
  filename: string;
  kind: 'photo' | 'video';
};

type SaveFilePicker = (options?: {
  suggestedName?: string;
}) => Promise<{
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}>;

export async function saveToGallery(media: CapturedMedia): Promise<void> {
  const file = new File([media.blob], media.filename, { type: media.blob.type });

  if (!navigator.canShare?.({ files: [file] })) {
    throw new Error('Il salvataggio nella galleria non è supportato da questo browser.');
  }

  await navigator.share({ files: [file] });
}

export async function saveToFiles(media: CapturedMedia): Promise<void> {
  const picker = (window as Window & {
    showSaveFilePicker?: SaveFilePicker;
  }).showSaveFilePicker;

  if (picker) {
    const handle = await picker.call(window, {
      suggestedName: media.filename
    });

    const writable = await handle.createWritable();
    await writable.write(media.blob);
    await writable.close();
    return;
  }

  downloadMedia(media);
}

function downloadMedia(media: CapturedMedia): void {
  const url = URL.createObjectURL(media.blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = media.filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
