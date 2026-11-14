import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveUploads, uploadsSchema, MAX_ATTACHMENT_BYTES } from '../src/attachments.js';
import { setup, pngData } from './helpers.js';

const image = { name: 'photo.png', mimeType: 'image/png', data: pngData };

test('uploads reject unsafe names, malformed base64, invalid metadata and unsupported edit types', () => {
  for (const name of ['../x', '..\\x', '/x', 'C:\\x', 'x:y', '.', '..', 'a\nb', 'a\0b']) {
    assert.equal(uploadsSchema().safeParse([{ ...image, name }]).success, false, name);
  }
  for (const data of ['', '!', 'a===', 'YQ', 'YQ=!', 'YR==', 'YQ==\n', 'data:image/png;base64,' + pngData]) {
    assert.equal(uploadsSchema().safeParse([{ ...image, data }]).success, false, data);
  }
  for (const file of [{ ...image, mimeType: 'bad' }, { ...image, path: '/tmp/x' }, { data: pngData }]) {
    assert.equal(uploadsSchema().safeParse([file]).success, false);
  }
  assert.equal(uploadsSchema(true).safeParse([]).success, false);
  assert.equal(uploadsSchema(true).safeParse([{ ...image, mimeType: 'application/pdf' }]).success, false);
  assert.equal(uploadsSchema().safeParse(Array(11).fill(image)).success, false);
  assert.equal(uploadsSchema().safeParse([]).success, true);
});

test('decoded byte limits include exact individual and combined boundaries', () => {
  const file = { name: 'large.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64') };
  assert.equal(uploadsSchema().safeParse([file, file]).success, true);
  assert.equal(uploadsSchema().safeParse([file, file, image]).success, false);
  assert.equal(uploadsSchema().safeParse([{ ...file, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }]).success, false);
});

test('uploads preserve bytes with generated names even for duplicate or reserved filenames', async (t) => {
  const { directory } = await setup(t);
  const files = [image, image, { name: 'CON.txt', mimeType: 'text/plain', data: Buffer.from('你好').toString('base64') }];
  const saved = await saveUploads(directory, files);
  assert.deepEqual(saved.map((file) => file.relativePath), ['attachments/1.png', 'attachments/2.png', 'attachments/3.txt']);
  for (let i = 0; i < files.length; i++) {
    assert.equal((await readFile(path.join(directory, saved[i].relativePath))).toString('base64'), files[i].data);
  }
});

test('invalid image signatures fail before any upload is written', async (t) => {
  const { directory } = await setup(t);
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    await assert.rejects(saveUploads(directory, [image, { ...image, mimeType, data: Buffer.from('invalid').toString('base64') }]), /valid PNG, JPEG or WebP/);
  }
  assert.deepEqual(await readdir(directory), ['requests.jsonl']);
});

test('JPEG and WebP inputs use the extension of their declared image type', async (t) => {
  const { directory } = await setup(t);
  const saved = await saveUploads(directory, [
    { name: 'misnamed.txt', mimeType: 'image/jpeg', data: Buffer.from('ffd8ffe000104a46494600ffd9', 'hex').toString('base64') },
    { name: 'photo', mimeType: 'image/webp', data: Buffer.from('524946460c000000574542505650384c00000000', 'hex').toString('base64') },
  ], true);
  assert.deepEqual(saved.map((file) => file.relativePath), ['attachments/1.jpg', 'attachments/2.webp']);
  assert.ok(saved.every((file) => file.isImage));
});
