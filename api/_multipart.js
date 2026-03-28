import Busboy from 'busboy';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_IMAGE_BYTES } });
    const fields = {};
    let fileBuffer = null;
    let fileMime = '';
    let fileName = '';

    busboy.on('file', (_name, file, info) => {
      fileName = info?.filename || '';
      fileMime = info?.mimeType || '';
      const chunks = [];
      file.on('data', (data) => chunks.push(data));
      file.on('limit', () => {
        reject(new Error('File too large.'));
      });
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('error', (err) => reject(err));
    busboy.on('finish', () => {
      resolve({ fields, fileBuffer, fileMime, fileName });
    });

    req.pipe(busboy);
  });
}
