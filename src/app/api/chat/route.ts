import { NextRequest } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export async function POST(req: NextRequest) {
  try {
    const { question, context, mode } = await req.json();

    if (!question || typeof question !== 'string') {
      return new Response(JSON.stringify({ error: 'Question is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const zai = await ZAI.create();

    const systemPrompts: Record<string, string> = {
      technical: `Ты — ИИ-ассистент, помогающий на технических собеседованиях. Отвечай кратко, точно и структурированно. Если вопрос про код — давай примеры. Если про архитектуру — описывай подход и trade-offs. Если про алгоритмы — объясняй сложность. Отвечай на русском языке.`,
      behavioral: `Ты — ИИ-ассистент, помогающий на поведенческих собеседованиях. Помоги сформулировать ответ по методу STAR (Situation, Task, Action, Result). Давай конкретные примеры из опыта. Отвечай на русском языке.`,
      general: `Ты — ИИ-помощник, который слушает разговор и помогает отвечать на вопросы. Формулируй чёткие, структурированные ответы. Если вопрос технический — давай технический ответ. Если общий — давай развёрнутый ответ. Отвечай на русском языке.`,
    };

    const systemPrompt = systemPrompts[mode || 'general'] || systemPrompts.general;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    if (context && Array.isArray(context)) {
      for (const msg of context.slice(-6)) {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    messages.push({ role: 'user', content: question });

    // Use non-streaming for reliability, then stream the response to client
    const completion = await zai.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    const content = completion.choices?.[0]?.message?.content || '';

    // Stream the response to the client in chunks
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        try {
          // Send the full content
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('Stream error:', err);
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
