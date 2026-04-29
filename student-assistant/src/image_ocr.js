export async function performOcr(env, buffer) {
  console.log(JSON.stringify({ event: 'ocr_started', buffer_length: buffer.byteLength }));
  
  try {
    const uint8Array = new Uint8Array(buffer);
    
    const response = await env.AI.run('@cf/microsoft/phi-2', {
      prompt: 'Extract and return all readable text from this image. If no text is readable, respond with "NO_TEXT".',
      image: Array.from(uint8Array),
      max_tokens: 2000
    });
    
    const text = response.response?.trim() || '';
    
    if (text.includes('NO_TEXT') || text.length < 5) {
      console.log(JSON.stringify({ event: 'ocr_no_text', text_length: text.length }));
      return null;
    }
    
    console.log(JSON.stringify({ event: 'ocr_successful', text_length: text.length }));
    return text;
  } catch (error) {
    console.error(JSON.stringify({ event: 'ocr_failed', error: error.message }));
    return null;
  }
}