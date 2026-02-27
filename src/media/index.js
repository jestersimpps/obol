const fs = require('fs');
const path = require('path');

const MIME_MAP = {
  photo: 'image/jpeg',
  voice: 'audio/ogg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  sticker: 'image/webp',
  animation: 'video/mp4',
  video_note: 'video/mp4',
};

const EXT_MAP = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

function getFileInfo(ctx) {
  const msg = ctx.message;
  if (!msg) return null;

  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      mediaType: 'photo',
      mimeType: 'image/jpeg',
      originalName: null,
      fileSize: largest.file_size || 0,
    };
  }

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      mediaType: 'document',
      mimeType: msg.document.mime_type || 'application/octet-stream',
      originalName: msg.document.file_name || null,
      fileSize: msg.document.file_size || 0,
    };
  }

  const types = ['voice', 'video', 'audio', 'sticker', 'animation', 'video_note'];
  for (const type of types) {
    if (msg[type]) {
      return {
        fileId: msg[type].file_id,
        mediaType: type,
        mimeType: msg[type].mime_type || MIME_MAP[type] || 'application/octet-stream',
        originalName: null,
        fileSize: msg[type].file_size || 0,
      };
    }
  }

  return null;
}

function generateFilename(fileInfo, filePath) {
  if (fileInfo.mediaType === 'document' && fileInfo.originalName) {
    return fileInfo.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const ext = extFromPath(filePath) || EXT_MAP[fileInfo.mimeType] || '';
  return `${fileInfo.mediaType}-${ts}${ext}`;
}

function extFromPath(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath);
  return ext || null;
}

async function downloadFile(token, filePath) {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function saveFile(buffer, assetsDir, filename) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const fullPath = path.join(assetsDir, filename);
  fs.writeFileSync(fullPath, buffer);
  return fullPath;
}

function formatSize(bytes) {
  if (!bytes) return 'unknown size';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildMemoryContent(fileInfo, filename, savedPath, caption) {
  let text = `File received: ${filename} (${fileInfo.mediaType}, ${formatSize(fileInfo.fileSize)}) saved to ${savedPath}`;
  if (caption) text += `. Caption: ${caption}`;
  return text;
}

function isImage(fileInfo) {
  if (fileInfo.mediaType === 'photo') return true;
  if (fileInfo.mediaType === 'sticker') return false;
  return fileInfo.mimeType?.startsWith('image/') || false;
}

function bufferToImageBlock(buffer, mimeType) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const type = allowed.includes(mimeType) ? mimeType : 'image/jpeg';
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: type,
      data: buffer.toString('base64'),
    },
  };
}

module.exports = {
  getFileInfo,
  generateFilename,
  downloadFile,
  saveFile,
  buildMemoryContent,
  isImage,
  bufferToImageBlock,
};
