import { extractPdfText } from './pdf_text_extractor.js';
import { performOcr } from './image_ocr.js';
import { ingestNote } from './knowledge.js';

export async function processUploadedFile(env, token, chatId, userId, fileId, mimeType, subject = 'General') {
  try {
    console.log(JSON.stringify({ event: 'file_processing_started', userId, fileId, mimeType }));
    
    const fileInfoUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
    const fileInfoRes = await fetch(fileInfoUrl);
    const fileInfo = await fileInfoRes.json();
    
    if (!fileInfo.ok) {
      throw new Error(`Failed to get file info: ${fileInfo.description}`);
    }
    
    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileRes = await fetch(fileUrl);
    const buffer = await fileRes.arrayBuffer();
    
    let extractedText = null;
    
    if (mimeType === 'application/pdf') {
      extractedText = await extractPdfText(buffer);
      if (!extractedText) {
        return { success: false, error: 'Could not extract text from PDF' };
      }
    } else if (mimeType.startsWith('image/')) {
      extractedText = await performOcr(env, buffer);
      if (!extractedText) {
        return { success: false, error: 'Could not extract text from image' };
      }
    } else {
      return { success: false, error: `Unsupported file type: ${mimeType}` };
    }
    
    const noteId = `file-${Date.now().toString(36)}`;
    
    await ingestNote(env, extractedText, subject, noteId);
    
    console.log(JSON.stringify({ 
      event: 'file_processed', 
      userId, 
      fileId, 
      mimeType, 
      subject,
      noteId,
      textLength: extractedText.length 
    }));
    
    return { success: true, noteId, textLength: extractedText.length };
  } catch (error) {
    console.error(JSON.stringify({ 
      event: 'file_processing_error', 
      userId, 
      fileId, 
      error: error.message 
    }));
    return { success: false, error: error.message };
  }
}

export function extractSubjectFromCaption(caption = '') {
  if (!caption) return 'General';
  
  const match = caption.match(/subject:(\S+)/i);
  if (match) {
    return match[1].replace(/-/g, ' ').trim();
  }
  
  if (caption.startsWith('/note') || caption.startsWith('/upload')) {
    return 'General';
  }
  
  if (caption.length > 3 && !caption.startsWith('/')) {
    return caption.trim().slice(0, 50);
  }
  
  return 'General';
}