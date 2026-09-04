const express = require('express');
const router = express.Router();

const SYSTEM_PROMPT = `You are "Feonix Assistant", the sentient 3D AI Copilot for Feonix AI (https://feonixai.com).
Your purpose is to assist software engineers, tech professionals, and interviewees in acing technical interviews, system design rounds, live coding challenges, and career growth.

Voice & Demeanor:
- You speak naturally, warmly, confidently, and like an articulate, world-class technical mentor.
- Keep your answers concise, direct, engaging, and clear (ideal for being spoken aloud naturally by text-to-speech).
- When explaining complex ideas, structure them with crisp bullet points or short paragraphs.
- Be encouraging and enthusiastic about engineering and interview success.

Key Knowledge about Feonix AI:
- Feonix AI is an advanced dual-layer AI copilot system designed for real-time technical interviews and high-stakes meetings.
- Low-latency voice chunk streaming (< 1.5s voice cues) and live context alignment.
- Live stealth teleprompter overlay that runs invisibly during Zoom/Teams/Google Meet calls.
- Sandbox Privacy Isolation: 100% private, enterprise-grade encrypted sandbox.
- Features: Real-time Answer Engine, Resume AI Optimizer, Job Analyzer & Matching, Behavioral Mock Prep (STAR method), and Post-Call Review Analytics.
- Pricing: Free Starter tier (100k tokens), Pro ($29/mo), and Enterprise unlimited tiers.

Always provide high-value, actionable, technically precise guidance.`;

// Intelligent fallback responses when external API is unreachable or offline
function generateSmartFallbackResponse(userMsg) {
  const q = (userMsg || '').toLowerCase();

  if (q.includes('feonix') || q.includes('what is') || q.includes('how does it work') || q.includes('feature')) {
    return "Feonix AI is your real-time 3D AI Copilot engineered specifically for technical interviews and high-stakes meetings. It listens via low-latency audio chunk streaming, provides sub-1.5 second stealth hints on your screen during calls, and isolates all session data in a zero-retention privacy sandbox. Beyond live interviews, it also features an AI Resume Optimizer and automated Mock Prep Simulator.";
  }

  if (q.includes('process') && q.includes('thread')) {
    return "A process is an independent executing program with its own private memory address space, stack, and heap. A thread is a lightweight path of execution within that process. Multiple threads share the same heap and memory, making inter-thread communication extremely fast, though you must guard against race conditions with locks or mutexes.";
  }

  if (q.includes('event loop') || q.includes('javascript') || q.includes('async')) {
    return "The JavaScript event loop constantly monitors the Call Stack and the Task Queues. When the synchronous Call Stack is empty, it processes all Microtasks—such as resolved Promises and MutationObservers—before picking up the next Macrotask like setTimeout, setInterval, or I/O events. This single-threaded non-blocking architecture allows high throughput.";
  }

  if (q.includes('system design') || q.includes('scale') || q.includes('architecture')) {
    return "When approaching system design, always follow the 4-step framework: 1. Clarify functional and non-functional requirements (read vs write heavy, latency, SLA). 2. Estimate scale (QPS, storage, bandwidth). 3. Define high-level architecture (Load balancer, API gateway, cache tier with Redis, primary-replica DBs). 4. Deep dive into bottlenecks: partition strategies, data replication, and failure handling.";
  }

  if (q.includes('star') || q.includes('behavioral') || q.includes('nervous') || q.includes('tell me about')) {
    return "For behavioral questions, always rely on the STAR framework: Situation, Task, Action, and Result. Dedicate 70% of your time to the Action—specifically what YOU uniquely architected, decided, or resolved—and quantify your Result with concrete metrics like 'reduced latency by 42%' or 'saved 15 engineer-hours weekly'.";
  }

  if (q.includes('price') || q.includes('pricing') || q.includes('cost') || q.includes('free')) {
    return "Feonix AI offers a generous Free Starter tier with 100,000 complimentary tokens so you can practice right away. Our Pro Tier is $29 per month and unlocks unlimited real-time interview assists, stealth overlay mode, audio chunk streaming, and custom resume tailoring.";
  }

  return `That's a fantastic question! In modern software engineering, mastering both the foundational mechanics and the architectural trade-offs is what sets apart top-tier candidates. Specifically regarding "${userMsg}", remember to articulate the trade-offs clearly: latency versus consistency, simplicity versus scalability, and always validate your assumptions before jumping into code. How can I help you practice or break this down further?`;
}

router.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message_required', message: 'A message string is required.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey || apiKey.startsWith('sk-proj-placeholder')) {
    const fallbackAnswer = generateSmartFallbackResponse(message);
    return res.json({
      answer: fallbackAnswer,
      model: 'feonix-smart-assistant-v3',
      source: 'Feonix Neural Core',
    });
  }

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-6).map((h) => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: String(h.content || ''),
      })),
      { role: 'user', content: message },
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 350,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('OpenAI API returned non-200:', response.status, errText);
      const fallbackAnswer = generateSmartFallbackResponse(message);
      return res.json({
        answer: fallbackAnswer,
        model: 'feonix-smart-assistant-fallback',
        source: 'Feonix Neural Core (Fallback)',
      });
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || generateSmartFallbackResponse(message);

    return res.json({
      answer,
      model,
      usage: data.usage,
      source: 'OpenAI + Feonix Copilot Intelligence',
    });
  } catch (err) {
    console.error('Assistant chat error:', err);
    const fallbackAnswer = generateSmartFallbackResponse(message);
    return res.json({
      answer: fallbackAnswer,
      model: 'feonix-smart-assistant-offline',
      source: 'Feonix Neural Core',
    });
  }
});

module.exports = router;
