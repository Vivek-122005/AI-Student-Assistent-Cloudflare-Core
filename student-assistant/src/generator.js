export async function generateAnswer(env, question, chunks) {
  if (!chunks || chunks.length === 0) {
    throw new Error('No context chunks provided for generation');
  }

  const contextParts = chunks.map((chunk, i) =>
    `[Note ${i + 1} | Subject: ${chunk.subject} | Relevance: ${(chunk.score * 100).toFixed(0)}%]\n${chunk.text}`
  );
  const context = contextParts.join('\n\n---\n\n');

  const prompt = `You are a personal study assistant. A student is asking you a question about their own study notes.

IMPORTANT RULES:
1. Answer ONLY using the information in the notes below. Do not use any outside knowledge.
2. If the notes do not contain enough information to answer, say exactly: "I don't have enough notes on this topic yet."
3. Keep your answer concise and clear — suitable for a student reviewing for exams.
4. Do not repeat the question back. Get straight to the answer.
5. If the notes contain conflicting information, mention it.

STUDENT'S NOTES:
${context}

QUESTION: ${question}

ANSWER:`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 500
    });

    const answer = result?.response?.trim();
    if (!answer) throw new Error('Empty response from AI model');

    return answer;
  } catch (err) {
    console.error(JSON.stringify({ event: 'generation_failed', error: err.message }));
    throw new Error('AI generation failed. Please try again.');
  }
}

export function formatRAGResponse(question, answer, chunks) {
  const sources = [...new Map(
    chunks.map(c => [c.noteId, { noteId: c.noteId, subject: c.subject }])
  ).values()];

  let response = `${answer}\n\n`;

  if (sources.length === 1) {
    response += `📚 _From your ${sources[0].subject} notes (\`${sources[0].noteId}\`)_`;
  } else {
    const sourceList = sources.map(s => `\`${s.noteId}\` (${s.subject})`).join(', ');
    response += `📚 _Sources: ${sourceList}_`;
  }

  return response;
}

export function generateNoResultsResponse(question, hasAnyNotes) {
  if (!hasAnyNotes) {
    return `I don't have any notes yet! Add study material first:\n\n\`/note your content here\`\n\nOnce you've added notes, I can answer questions about them.`;
  }

  return `I couldn't find relevant notes for that question.\n\nThis could mean:\n• You haven't added notes on this topic yet\n• Try rephrasing your question\n• Add notes with: \`/note your content about this topic\`\n\n_Tip: Use \`/notes list\` to see what topics you've already saved._`;
}