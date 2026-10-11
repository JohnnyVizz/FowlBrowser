// File upload through upload_files; the page shows name, size and the first bytes.
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
  name: 'upload',
  async run(t) {
    const path = join(tmpdir(), `fowlbrowser-upload-${t.tag}.txt`);
    const body = `hello upload ${t.tag}\n`;
    await writeFile(path, body);
    try {
      const tab = await t.open(`${t.site}/upload.html`);
      const s = await t.snapshot(tab);
      t.step('upload_files');
      await t.call('upload_files', { tab, ref: t.ref(s, ['button', 'textbox'], /Attachment/), paths: [path], snapshot: false });
      t.step('assert');
      const r = await t.until(async () => { const v = await t.resultOf(tab); return Array.isArray(v) && v; }, 'file shown on page');
      t.eq(r, [{ name: `fowlbrowser-upload-${t.tag}.txt`, size: Buffer.byteLength(body), head: body }], 'uploaded file');
    } finally {
      await rm(path, { force: true });
    }
  },
};
