import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
export const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function decodedSize(data) {
  return data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

const attachmentSchema = z.object({
  name: z.string().min(1).max(255).refine(
    (name) => !/[\\/:\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..',
    'Attachment name must be a filename, not a path',
  ).describe('Original filename, without directory components'),
  mimeType: z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
    .describe('MIME type, for example image/png, application/pdf or text/plain'),
  data: z.string().min(4).max(MAX_BASE64_LENGTH).refine((data) =>
    data.length <= MAX_BASE64_LENGTH && data.length % 4 === 0 &&
    decodedSize(data) <= MAX_ATTACHMENT_BYTES && Buffer.from(data, 'base64').toString('base64') === data,
  'Expected canonical base64 of a non-empty file of at most 10 MiB (no data URL prefix)'),
}).strict();

export function uploadsSchema(imagesOnly = false) {
  const item = imagesOnly ? attachmentSchema.extend({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  }) : attachmentSchema;
  return z.array(item).min(imagesOnly ? 1 : 0).max(10).superRefine((files, context) => {
    if (files.reduce((total, file) => total + decodedSize(file.data), 0) > MAX_ATTACHMENTS_BYTES) {
      context.addIssue({ code: 'custom', message: 'Attachments exceed the combined 20 MiB limit' });
    }
  });
}

function matchesImage(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR';
  if (mimeType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export async function saveUploads(directory, files, imagesOnly = false) {
  // Validate the whole batch before writing anything or starting the CLI.
  const uploads = uploadsSchema(imagesOnly).parse(files).map((file, index) => {
    const bytes = Buffer.from(file.data, 'base64');
    const mimeType = file.mimeType.toLowerCase();
    const isImage = mimeType.startsWith('image/');
    if (isImage && !matchesImage(bytes, mimeType)) {
      throw new Error(`Attachment ${index + 1}: expected a valid PNG, JPEG or WebP matching mimeType`);
    }
    // Never use client filenames as paths. Preserve safe extensions for file readers.
    const originalExtension = path.extname(file.name);
    const extension = IMAGE_EXTENSIONS[mimeType] || (/^\.[a-zA-Z0-9]{1,16}$/.test(originalExtension) ? originalExtension : '.bin');
    const relativePath = `attachments/${index + 1}${extension}`;
    return { name: file.name, mimeType, relativePath, isImage, bytes };
  });
  if (uploads.length) {
    await mkdir(path.join(directory, 'attachments'));
    for (const file of uploads) {
      await writeFile(path.join(directory, file.relativePath), file.bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  return uploads.map(({ bytes, ...file }) => file);
}
