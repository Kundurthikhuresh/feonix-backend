// Session types and contextual actions.
//
// There are exactly two kinds of call, matching how the product is actually
// used: an interview, where you are the candidate being asked questions, and a
// regular call, where you are a participant who wants a copilot. Everything
// else — tone, structure, what gets emphasised — follows from that one choice
// plus the session's own job description, not from a menu of personas.

const OWNER_VOICE_RULE =
  'OWNER VOICE, FIRST PERSON: Answer as the candidate talking about their own work, in simple confident spoken English. ' +
  'Use first-person ownership phrases naturally wherever they fit — "I used...", "I implemented...", "I developed...", ' +
  '"I worked on...", "I did...", "I handled...", "I faced this issue...", "I solved it by...", "In my project...", ' +
  '"My approach would be..." — but vary them and do not force one into every sentence. Only claim as done what the ' +
  'resume or trusted experience supports; for anything else (hypotheticals, unknown details) say "I would..." ' +
  'instead of inventing employers, projects, outcomes or numbers.';

/**
 * The reply format. The length rule is injected rather than hardcoded: when the
 * session carries its own instructions ("answer in 10 lines"), stating a
 * competing "5-6 lines" here makes the model pick one, and it picks this one.
 * So the conflict is removed at the source instead of being arbitrated.
 */
// The shape of every answer card: one direct sentence with the key phrase in
// bold (shown on the same line as "Answer:"), then bullets with the important
// term of each in bold. Easy to glance at and read out mid-interview, where a
// block of paragraphs is not.
const ANSWER_SHAPE = [
  'Write [ANSWER] in exactly this shape (markdown):',
  'Line 1: ONE direct sentence that answers the question. Bold ONLY its key phrase (3 to 7 words), never the whole sentence. No heading, no "Answer:" label.',
  'Then 4 to 6 bullet lines (never more than 6), each starting with "- ", each one or two complete sentences. EVERY bullet bolds its own key term or phrase (2 to 6 words).',
  'Extra depth goes inside the bullets, not into more bullets. Nothing after the last bullet: no closing paragraph, no summary, no sub-headings.',
  '',
  'Example of the shape (for a different question, "What is Python?"):',
  'Python is a **high-level, interpreted programming language** used to build many kinds of software.',
  '- It is known for **simple, readable syntax**, so code reads almost like plain English and teams can maintain it easily.',
  '- Python is **dynamically typed**, which means variable types are checked at runtime, making it quick to prototype.',
  '- It ships with a huge **standard library** and ecosystem, like Django for web apps and Pandas for data work.',
  '- I have used it for **automation scripts and backend APIs**, where its fast development speed really helped.',
].join('\n');

const CODING_ANSWER_SHAPE = [
  'Write [ANSWER] in exactly this shape (markdown):',
  'Line 1: ONE direct sentence saying what the solution does, with the key idea in **bold**.',
  'Then the complete runnable code in one fenced code block.',
  'Then 4 to 6 bullet lines, each starting with "- ", explaining the approach, the logic, the **Time and Space complexity** and the edge cases, with the key term of each bullet in **bold**.',
].join('\n');

function formatBlock(lengthRule, pointsRule, isCoding = false) {
  if (isCoding) {
    return [
      'Reply in exactly this format, tags on their own lines, [ANSWER] first:',
      '',
      '[ANSWER]',
      CODING_ANSWER_SHAPE,
      `Depth: ${lengthRule}`,
      '[POINTS]',
      pointsRule || '- 3 to 4 key technical approach & Big-O speaking beats',
      '',
      'CRITICAL CHATGPT-GRADE FULL CODE DIRECTIVE (ZERO PLACEHOLDERS / COMPLETE WORKING CODE):',
      'Provide the 100% COMPLETE, production-ready, fully runnable code inside standard markdown code block(s) (```<language> ... ```).',
      '1. COMPLETE IMPLEMENTATION: Output the full code without truncating, omitting, or taking shortcuts. Include all imports, class declarations, constructors, fields, getters/setters, helper methods, business logic, and error handling.',
      '2. STRICTLY NO PLACEHOLDERS: NEVER use comments like "// TODO: implement", "// ...", "// rest of code", or ellipsis (...). Every method and routine must be fully coded.',
      '3. MULTI-FILE OR MULTI-CLASS SYSTEMS: If the problem asks for multiple classes or files, write out EACH file completely with clear file path headings.',
      '4. POST-CODE TECHNICAL BREAKDOWN:',
      '   - Step-by-step logic walkthrough of how the code executes.',
      '   - Design choices, data structures, and edge cases handled.',
      '   - Time & Space Complexity analysis using Big-O notation.',
      '',
      'MANDATORY 90% HUMAN INTERVIEW THINKING & QUALITY RULES (UNDER 10% AI, 90% HUMAN THINKING):',
      '1. UNDER 10% AI, 90% HUMAN THINKING: Sound like an articulate, thoughtful senior engineer speaking candidly in an interview room. Avoid robotic AI transitions ("furthermore", "additionally", "in conclusion") and textbook boilerplate.',
      `2. ${OWNER_VOICE_RULE}`,
      '3. RICH DEPTH & INFORMATION: Give a comprehensive, in-depth explanation covering the algorithmic intuition, data structures, Big-O Time & Space complexity, edge cases, and production considerations.',
      '4. ANSWER LIKE AN OWNER, NOT A BOT: Speak with direct engineering authority. Never sound like a chatbot, tutor, or assistant ("Sure! Here is the code", "As an AI").',
      '5. CONTEXTUAL RELEVANCE: If the question or prompt is brief, fragmented, or references prior dialogue, examine the recent transcript to identify the exact technical problem and deliver a focused, highly relevant solution.',
    ].join('\n');
  }

  return [
    // [ANSWER] first: the copilot shows only the spoken answer, so writing the
    // points first delayed the first visible words and made the card jump when
    // its content switched from the points to the answer.
    'Reply in exactly this format, tags on their own lines, [ANSWER] first:',
    '',
    '[ANSWER]',
    ANSWER_SHAPE,
    `Depth (spread across the opening sentence and the bullets): ${lengthRule}`,
    '[POINTS]',
    pointsRule || '- 4 to 6 substantive, high-impact speaking beats summarizing key pillars',
    '',
    'MANDATORY 90% HUMAN INTERVIEW THINKING & QUALITY RULES (UNDER 10% AI, 90% HUMAN THINKING):',
    '1. UNDER 10% AI, 90% HUMAN THINKING: Deliver an authentic, conversational spoken interview answer. Sound 90% like natural human thinking and under 10% AI generated. Absolutely no textbook essays, robotic transition words ("furthermore", "moreover", "in conclusion"), or generic AI summaries.',
    `2. ${OWNER_VOICE_RULE}`,
    '3. MORE SENTENCES & DEEP INFORMATION: Provide a rich, thorough, informative answer with deep substance. Cover the core direct answer, how it works under the hood, real-world architectural experience, performance optimization, and trade-offs/edge cases.',
    '4. ANSWER LIKE AN OWNER, NOT A BOT: Speak strictly as the engineer and architect who made the technical decisions, owned production deployments, and resolved outages. Never speak as an AI, bot, or spectator.',
    '5. CONTEXTUAL RELEVANCE: If the question is short, fragmented (e.g. "What?", "Why?", "How?"), or refers to earlier remarks, inspect the recent conversation transcript to identify the true technical subject and answer THAT directly and accurately. Never provide an irrelevant answer.',
    '6. For behavioral questions, structure points using STAR with real metrics, technical decisions, and tangible outcomes.',
    'All [POINTS] must be affirmative, high-impact speaking beats. Never emit disclaimers or negative points.',
  ].join('\n');
}

/**
 * Detects if the prompt is asking for code, programming, algorithms, functions, queries, or implementation.
 */
function isCodingQuestion(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return false;

  // Code block or markdown code markers present
  if (/```|`[a-z0-9_().]+`/i.test(q)) return true;

  // Direct code / program / syntax / implementation keywords
  if (/\b(example|sample|demo|snippet|syntax|source)\s+code\b/i.test(q)) return true;
  if (/\bcode\s+(example|sample|demo|snippet|template|syntax|solution)\b/i.test(q)) return true;
  if (/\b(write|create|implement|provide|generate|give|show|build|develop|solve|draft|need|want|share)\b.*?\b(code|program|script|function|class|method|query|algorithm|snippet|solution|component|syntax|api|backend|frontend|system|app|application|service)\b/i.test(q)) return true;
  if (/\b(write\s+a?\s*code|write\s+code|code\s+(for|to|of|in|that|addition|subtraction|multiplication|division)|coding\s+question|coding\s+problem)\b/i.test(q)) return true;

  // Programming languages mentioned in combination with code, tasks, or systems
  const langRegex = /\b(python|javascript|typescript|java|c\+\+|cpp|c#|csharp|golang|go|rust|ruby|php|swift|kotlin|sql|html|css|bash|powershell|scala|dart|r|regex)\b/i;
  if (langRegex.test(q)) {
    if (/\b(using|in|with|via)\s+(python|javascript|typescript|java|c\+\+|cpp|c#|golang|go|rust|ruby|php|swift|kotlin|sql|html|css|bash|powershell|scala|dart|r)\b/i.test(q)) return true;
    if (/\b(code|script|program|solution|function|implementation|snippet|syntax|class|method|app|application|system|project|algorithm)\b/i.test(q)) return true;
  }

  if (/\b(with|in)\s+code\b/i.test(q)) return true;
  if (/\b(write\s+(a\s+)?python|write\s+(a\s+)?javascript|write\s+(a\s+)?typescript|write\s+(a\s+)?java|write\s+(a\s+)?c\+\+|write\s+(a\s+)?cpp|write\s+(a\s+)?sql|write\s+(a\s+)?query)\b/i.test(q)) return true;
  if (/\b(sql\s+query|select\s+.*\s+from|insert\s+into|update\s+.*\s+set|delete\s+from|create\s+table)\b/i.test(q)) return true;
  if (/\b(leetcode|hackerrank|codewars|codeforces)\b/i.test(q)) return true;
  if (/\b(write\s+a\s+program|write\s+program|program\s+to\s+[a-z]+|function\s+to\s+[a-z]+)\b/i.test(q)) return true;

  // Data structures & algorithms
  if (/\b(implement|code|program|build|create|design)\s+(a\s+|an\s+|the\s+)?([a-z0-9_-]+\s+)?(binary search|quicksort|mergesort|dfs|bfs|dijkstra|lru cache|linked list|stack|queue|tree|heap|two sum|fibonacci|palindrome|reverse|if condition|while loop|for loop|graph|trie|dynamic programming|recursion)\b/i.test(q)) return true;
  if (/\b(if\s+condition|for\s+loop|while\s+loop|switch\s+case)\s+code\b/i.test(q)) return true;

  // Software projects, systems, architectures, assignments
  if (/\b(banking|library|inventory|hospital|school|hotel|student|employee|management\s+system)\b/i.test(q) && (langRegex.test(q) || /\b(menu|console|oop|object-oriented|class|classes)\b/i.test(q))) return true;
  if (/\b(full\s+code|give\s+full\s+code|complete\s+code|source\s+code|entire\s+code)\b/i.test(q)) return true;
  if (/\b(rest\s+api|crud|mvc|database|spring\s+boot|express|django|flask|react|nextjs)\b/i.test(q) && /\b(create|build|write|implement|code)\b/i.test(q)) return true;

  // Code syntax tokens in prompt (e.g. pasted code to fix/complete)
  if (/\b(def|class|public\s+static\s+void|import\s+java|const|let|var|function\*?|#include|package\s+com)\b/.test(q)) return true;

  return false;
}

/**
 * What kind of question this is, so the answer can be the size a person would
 * actually give.
 *
 * One fixed shape for every question is what made short questions read as
 * essays: "are you willing to travel?" came back with the same 5-6 line
 * structure as "tell me about a time you led a project". Order matters here —
 * the specific patterns are tested before the generic auxiliary-verb opener,
 * because "Do you have experience with EPMS?" opens like a yes/no question but
 * is really asking for evidence.
 */
function classifyQuestion(question) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return 'OPEN_ENDED';

  // Coding questions: when the user explicitly asks for code, functions, queries or programs
  if (isCodingQuestion(q)) {
    return 'CODING';
  }

  // The interviewer asking the candidate to go over something again. Checked
  // first: several of these open with an auxiliary verb and would otherwise
  // fall through to YES_NO.
  if (/\b(repeat|say that again|what do you mean|clarify|didn'?t catch|come again|elaborate|expand on that|go over that again|run that by me|what was that)\b/.test(q)) {
    return 'CLARIFICATION';
  }
  // "tell me about a difficult UPS failure you handled" is the same request as
  // "tell me about a time" — it just names the situation instead. "Tell me
  // about yourself" is not: that is an opener, not a story.
  if (/\b(tell me about a time|describe a (time|situation)|give me an example|walk me through a time|have you ever had to)\b/.test(q)
      || /^tell me about (?!yourself\b)(a|an|the|your|some)\b/.test(q)) {
    return 'BEHAVIORAL';
  }
  if (/\b(how would you|what would you do|suppose|imagine|if you (were|had to)|walk me through how you'?d)\b/.test(q)) {
    return 'SCENARIO';
  }
  if (/\b(why (are|do) you|what (interests|attracts) you|why this|why our|where do you see yourself|what are you looking for)\b/.test(q)) {
    return 'MOTIVATION';
  }
  if (/\b(experience with|worked with|have you used|how (many years|long have you)|familiar with|hands.?on with)\b/.test(q)) {
    return 'EXPERIENCE';
  }
  // "what is" only counts when it asks about a thing, not about the candidate:
  // "what is your notice period?" is a one-line factual answer, not a technical
  // explanation.
  if (/\b(how (do|does|would) (you|it)|explain|what'?s the difference|troubleshoot|diagnose|why does)\b/.test(q)
      || /\bwhat (is|are) (?!your\b|you\b)/.test(q)) {
    return 'TECHNICAL';
  }
  // Auxiliary-verb opener with no other signal: a yes/no or willingness check.
  if (/^(are|is|was|were|do|does|did|have|has|had|can|could|would|will|shall|should|any)\b/.test(q)) {
    return 'YES_NO';
  }
  if (q.split(/\s+/).length <= 12) return 'SHORT_DIRECT';
  return 'OPEN_ENDED';
}

/**
 * Spoken length and shape per question type.
 *
 * Each rule opens with "exactly N sentences" rather than a line/word range.
 * Measured (see explicitLengthRule below): gpt-4o-mini quietly ignores a line
 * or word target — a 90-130 word range and a 180-260 word range produced the
 * same ~75-word answer — but holds to an explicit sentence count. So a range
 * here would silently collapse back to the model's own short default; the
 * count is what actually buys the longer, more detailed answer.
 */
const TYPE_LENGTH_RULES = {
  CODING:
    'Deliver a production-grade response featuring the COMPLETE, 100% WORKING CODE first in standard markdown code block(s) (```<language> ... ```) with zero placeholders, zero "// TODO" comments, and full implementation of all classes, methods, and logic. Follow with 8 to 12 substantive spoken sentences explaining the algorithmic approach, intuition, step-by-step logic, Big-O Time & Space complexity, edge case handling, and production trade-offs with 90% human thinking and under 10% AI precision.',
  YES_NO:
    'State a direct, confident answer upfront, followed by 6 to 9 detailed conversational sentences explaining the technical reasoning, real-world production experience, design decisions, and concrete outcomes.',
  SHORT_DIRECT:
    '6 to 10 comprehensive spoken sentences explaining the core concept, practical mechanisms under the hood, hands-on production setup, and critical trade-offs with 90% human thinking and deep technical clarity.',
  EXPERIENCE:
    '8 to 14 rich conversational sentences detailing hands-on architectural experience: the tech stack and tools chosen, system design decisions, challenges resolved in production, performance optimizations, and measurable impact.',
  BEHAVIORAL:
    '8 to 14 structured STAR sentences with deep substance: the specific high-stakes Situation and Task, the architectural & technical Action taken, and the measurable Result with real metrics, lessons learned, and trade-offs. Sound 90% human and conversational.',
  TECHNICAL:
    '8 to 14 comprehensive spoken sentences delivering deep technical information: how the concept works under the hood, architectural patterns, hands-on implementation details from real systems, performance considerations, and key trade-offs without generic AI fluff.',
  SCENARIO:
    '8 to 14 thorough conversational sentences detailing the step-by-step engineering approach: triage and diagnostics, root cause analysis, architecture decisions, execution plan, rollback/mitigation strategies, and post-incident hardening.',
  MOTIVATION:
    '6 to 10 authentic sentences connecting hands-on technical background and engineering values with the company\'s specific technical scale, architecture, and engineering challenges.',
  CLARIFICATION:
    '5 to 8 crystal-clear, informative spoken sentences clarifying the technical concept thoroughly, explaining under-the-hood mechanics and practical distinctions.',
  OPEN_ENDED: null,   // falls back to DEFAULT_LENGTH_RULE
};

/** How many [POINTS] fragments suit this type. */
function pointsRuleFor(type) {
  if (type === 'CODING') {
    return '- 3 to 4 key technical fragments: algorithm intuition, data structures, Big-O Time & Space complexity, key edge cases';
  }
  if (['YES_NO', 'SHORT_DIRECT', 'CLARIFICATION'].includes(type)) {
    return '- 3 to 4 high-impact speaking beats summarizing core stance, technical mechanism, and practical application';
  }
  return '- 4 to 6 substantive, high-impact speaking beats covering core architecture, implementation details, metrics, and trade-offs';
}

const DEFAULT_LENGTH_RULE =
  'What to say out loud: Deliver 8 to 14 comprehensive, authentic spoken sentences packed with rich technical information, under-the-hood mechanics, real production experience, and practical trade-offs. Sound 90% like natural human thinking and under 10% AI generated.';

/**
 * Parses user numeric line requests (e.g. "answer in 5 lines", "give 6 lines").
 */
function explicitLengthRule(context) {
  const m = String(context || '').match(/(\d{1,3})\s*(?:short\s*)?(?:lines?|sentences?|points?)/i);
  if (!m) return null;
  const n = Math.max(1, Math.min(50, Number(m[1])));
  return `What to say out loud: provide an authentic, spoken response of ${n} sentences in a natural senior engineer voice with 90% human thinking and under 10% AI precision.`;
}

const CONTEXT_LENGTH_RULE =
  'What to say out loud. The candidate\'s instructions at the end of this\n' +
  'prompt decide the length and shape of this section — follow them exactly.';

/**
 * Technical terms in a block of text: acronyms, product names, CamelCase.
 *
 * Lifted out of transcribe.js, which already had exactly this regex for
 * building Whisper's vocabulary hint. It is reused rather than duplicated so
 * the terms the transcriber is primed to hear and the terms the answer is
 * grounded against can never drift apart.
 */
function technicalTerms(text, limit = 60) {
  const seen = new Set();
  const terms = [];
  for (const m of String(text || '').match(/\b[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*\b|\b[A-Z][a-z]{2,}\b/g) || []) {
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(m);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Words too common to be worth flagging as an unevidenced technology. */
const TERM_STOPWORDS = new Set([
  'the', 'this', 'that', 'you', 'your', 'they', 'there', 'experience', 'role',
  'support', 'work', 'working', 'team', 'teams', 'site', 'sites', 'level',
  'approximately', 'participate', 'including', 'write', 'small', 'hybrid',
  'overnight', 'legacy', 'data', 'center', 'centers', 'centre', 'engineer',
  'engineers', 'company', 'position', 'candidate', 'preferred', 'required',
  'and', 'with', 'from', 'some', 'must', 'will', 'may', 'per', 'day', 'days',
]);

/**
 * The grounding block: which technologies the candidate actually has evidence
 * for, and which ones only the employer asked for.
 *
 * A term appearing in the job description says what the employer wants. It says
 * nothing about the candidate. The QA run showed the model treating the two as
 * the same thing — it claimed Siemens Desigo experience because Desigo was in
 * the job description, when the resume never mentions it. Naming the gap
 * explicitly is what stops that.
 */
function groundingBlock(resume, jobDescription) {
  const resumeText = String(resume || '');
  const jdTerms = technicalTerms(jobDescription);
  if (!jdTerms.length) return null;

  const haystack = resumeText.toLowerCase();
  const unevidenced = jdTerms.filter(
    (t) => !TERM_STOPWORDS.has(t.toLowerCase()) && !haystack.includes(t.toLowerCase())
  );
  if (!unevidenced.length) return null;

  return [
    'Grounding — read this before claiming any experience:',
    '',
    'These appear in the job description but NOT anywhere in the candidate\'s',
    'resume, so there is no evidence the candidate has ever used them:',
    '',
    unevidenced.join(', '),
    '',
    'They are what the employer is asking for, not what the candidate has done.',
    'Never say the candidate has used one of them. If asked about one directly,',
    'say plainly that it is not something they have worked with, then give the',
    'closest thing they genuinely have done — that is a stronger answer than a',
    'claim the interviewer can disprove in one follow-up question.',
  ].join('\n');
}

const SHARED_RULES = [
  'Rules:',
  '- UNDER 10% AI GENERATED OUTPUT, 90% HUMAN THINKING: The output must sound 90% like authentic human interview thinking and under 10% AI generated. Strictly avoid robotic AI transitions ("furthermore", "additionally", "in conclusion", "it is worth noting", "it is vital to understand"), and textbook boilerplate. The answer is laid out as one bold opening sentence plus bullets (see the format below), but each bullet still reads like something a person would say. Talk like an articulate, seasoned engineer speaking directly and thoughtfully in an interview room.',
  '- MORE SENTENCES & HIGH TECHNICAL DEPTH: Deliver thorough, informative, and detailed answers (8 to 14+ substantive sentences under [ANSWER] and 4 to 6 rich speaking beats under [POINTS]). Provide deep technical value: explain under-the-hood mechanisms, real architectural designs, performance optimization, and trade-offs. Never give shallow 2-3 line summaries.',
  `- ${OWNER_VOICE_RULE}`,
  '- ANSWER LIKE AN OWNER, NOT A BOT: You are the candidate and the direct owner of the architecture, code, and systems. Speak with authentic ownership and conviction. NEVER speak as an AI bot, assistant, or third person (never say "As an AI", "Here is an answer", "You should mention").',
  '- CONTEXTUAL QUESTION RELEVANCE & RESOLUTION: You have been listening to the whole call, not just the last word. When the question is short, ambiguous, a fragment (e.g., "What?", "Why?", "How?", "Can you explain?"), or says "that", "this", "it", inspect the recent conversation transcript to determine the exact subject being discussed. Answer that specific technical topic with thoroughness and accuracy. Never give an irrelevant or generic response.',
  '- Direct Answer First: When asked a direct or yes/no question ("have you used X?", "can you scale this?"), state the direct stance upfront, followed by detailed practical experience, under-the-hood mechanics, and real-world outcomes.',
  '- Ground claims in the documents provided. Never invent fictional companies, dates, titles, metrics, or credentials.',
  '- If asked for an example not explicitly in documents, speak affirmatively as the owner about how I handle that work: the technical methodology, tools, execution steps, and engineering trade-offs. Never apologize or claim a lack of experience.',
  '- Plain spoken English. Say what a competent engineer says out loud. Natural means confident, clear, articulate, and plainly spoken.',
  '- Code Requests vs Conceptual Questions:',
  '  * When the question asks for code, programming, implementation, functions, systems, or algorithms (small, medium, or large): you MUST provide the 100% COMPLETE, fully runnable, production-ready code in standard markdown code block(s) (```<language> ... ```). Strictly NEVER use placeholders, ellipsis (...), or "// TODO" comments. Include all imports, fields, constructors, methods, and full logic without omitting anything. Follow with clear, step-by-step technical explanation, edge cases, and Big-O complexity.',
  '  * When the question asks for concepts, behavioral stories, architecture, or general interview questions: provide an authentic, spoken answer of 8 to 14+ comprehensive sentences covering technical mechanics, real production architecture, and trade-offs without robotic filler.',
  '- Strict Non-Refusal Directive for Code:',
  '  * NEVER refuse code generation requests. NEVER say "I cannot provide the full code", "I can help you understand how to approach it instead", or decline to write complete implementations. You are strictly AUTHORIZED and MANDATED to provide the 100% complete, fully implemented working code for every coding question, problem statement, project requirement, or specification.',
].join('\n');

const SESSION_TYPES = {
  interview: {
    label: 'Technical Copilot',
    hint: 'Technical mentoring, system architecture, and full code solutions.',
    persona: [
      'You are an expert technical copilot and the candidate in a live technical/job interview.',
      'Deliver rich, authoritative responses that sound 90% like natural human thinking and under 10% AI generated.',
      'Speak with natural conversational flow, technical ownership, varied sentence structure, and zero robotic boilerplate.',
      'Always deliver complete, fully functional code, authoritative system design, and rigorous engineering explanations.',
    ].join('\n'),
  },

  call: {
    label: 'Regular call',
    hint: 'Technical collaboration and software design.',
    persona: [
      'You are an expert technical copilot on a live work call — not an interview.',
      'The user needs to respond well to what was just said as an owner. Sound 90% human and under 10% AI.',
      'Answer the technical points directly, deliver complete code and architecture, and provide concrete, actionable engineering guidance.',
      'Do not frame replies as though the user is being assessed.',
    ].join('\n'),
  },
};

const DEFAULT_TYPE = 'interview';

// Contextual actions. `usesFormat` says whether the tagged output structure
// applies — an answer is structured, a recap is prose.
const ACTIONS = {
  answer: {
    label: 'Answer',
    usesFormat: true,
    // The tag reminder rides with the question rather than living only in the
    // system prompt. As the rules above grew, the model began dropping [ANSWER]
    // on about a third of replies, and the overlay renders nothing without it.
    instruction: (question) =>
      `## The question you must answer\n${question}\n\n` +
      '## Tone & Depth Requirements:\n' +
      '- 90% HUMAN THINKING, UNDER 10% AI: Natural, articulate spoken delivery as a senior practitioner. Strictly zero textbook essays or robotic filler phrases ("furthermore", "additionally", "in conclusion").\n' +
      '- MORE SENTENCES & RICH INFORMATION: Deliver 8 to 14+ detailed, substantive sentences under [ANSWER] and 4 to 6 comprehensive speaking beats under [POINTS]. Detail under-the-hood mechanics, real production architecture, and trade-offs.\n' +
      `- ${OWNER_VOICE_RULE}\n` +
      '- CONTEXTUAL QUESTION RESOLUTION: If the question is brief, fragmented (e.g. "What?", "Why?", "How?"), or references previous speech, inspect the recent conversation transcript above to answer the true underlying technical topic with direct relevance.\n' +
      '- ANSWER LIKE AN OWNER, NOT A BOT: You are the engineer who architected, implemented, and owns the solution.\n' +
      '## Reminder\nStart with the [ANSWER] tag on its own line, then the reply in the required shape\n' +
      '(one direct sentence with the key phrase in **bold**, then 4 to 6 "- " bullets with key terms in **bold**),\n' +
      'then the [POINTS] tag and the points. [ANSWER] is mandatory and comes first.',
  },

  shorten: {
    label: 'Shorten',
    usesFormat: true,
    instruction: (question) =>
      `## The question\n${question}\n\n` +
      '## Task\nAnswer it again, materially shorter: in [ANSWER], one direct sentence with\n' +
      'the key phrase in **bold**, then at most two short "- " bullets. At most three points.\n' +
      'Cut adjectives and hedges first.',
  },

  deepen: {
    label: 'More detail',
    usesFormat: true,
    instruction: (question) =>
      `## The question\n${question}\n\n` +
      '## Task\nAnswer it again with more substance: name the specific system,\n' +
      'number, or decision that makes it credible. Still no preamble.',
  },

  recap: {
    label: 'Recap',
    usesFormat: false,
    instruction: () =>
      '## Task\nSummarise the conversation so far for the user, who may have lost\n' +
      'the thread. Lead with where things currently stand, then what was covered.\n' +
      'Six lines maximum. Plain prose, no tags, no headings.',
  },

  followups: {
    label: 'Ask them',
    usesFormat: false,
    instruction: () =>
      '## Task\nSuggest three questions the user should ask the other side, based\n' +
      'on what has actually been said and on the role or call description. Make\n' +
      'them specific to this conversation — nothing that could be asked anywhere.\n' +
      'One per line, no numbering, no preamble.',
  },
};

const DEFAULT_ACTION = 'answer';

/** Full system prompt for a session type / action pair. */
function systemPromptFor(typeKey, actionKey, language, sessionContext, question, grounding) {
  const type = SESSION_TYPES[typeKey] || SESSION_TYPES[DEFAULT_TYPE];
  const action = ACTIONS[actionKey] || ACTIONS[DEFAULT_ACTION];

  const parts = [type.persona, '', SHARED_RULES];
  // Named gaps between what the employer asked for and what the candidate can
  // evidence. Sits with the rules, not with the documents, so it is read as an
  // instruction rather than as more material to draw on.
  if (grounding) parts.push('', grounding);
  if (language && language !== 'English') {
    parts.push('', `Reply in ${language}, regardless of the language of the question.`);
  }
  const hasContext = Boolean(sessionContext && sessionContext.trim());
  if (action.usesFormat) {
    /* Precedence, most specific first:
     *   1. an explicit instruction from the candidate ("answer in 10 lines")
     *   2. any other session instructions, which decide shape themselves
     *   3. the shape this kind of question actually calls for
     *   4. the generic default
     * The classifier slots in at 3, so it guides the answer without ever
     * overriding something the candidate asked for. */
    const questionType = classifyQuestion(question);
    const isCoding = questionType === 'CODING';
    const explicit = hasContext ? explicitLengthRule(sessionContext) : null;
    const lengthRule =
      explicit ||
      (hasContext ? CONTEXT_LENGTH_RULE : (TYPE_LENGTH_RULES[questionType] || DEFAULT_LENGTH_RULE));
    parts.push('', formatBlock(lengthRule, pointsRuleFor(questionType), isCoding));
  }

  // The user's own session instructions go LAST and in the system prompt, so
  // they genuinely override the default format above. Putting them in a user
  // message left the "5-6 short spoken lines" rule winning, and an explicit
  // "answer in 10 lines" was silently ignored.
  if (hasContext) {
    parts.push(
      '',
      'The candidate has given the following instructions for this session.',
      'They OVERRIDE anything above that conflicts with them, including the',
      'length and shape of [ANSWER]. Follow them exactly. They do not override',
      'the rule against inventing experience, and they never change the tag',
      'format itself.',
      '',
      sessionContext.trim()
    );
  }
  return parts.join('\n');
}

/** What the client renders, so the UI never hardcodes these lists. */
function catalogue() {
  return {
    session_types: Object.entries(SESSION_TYPES).map(([key, t]) => ({
      key,
      label: t.label,
      hint: t.hint,
    })),
    actions: Object.entries(ACTIONS).map(([key, a]) => ({ key, label: a.label })),
    languages: [
      'English', 'Spanish', 'French', 'German', 'Portuguese',
      'Hindi', 'Telugu', 'Tamil', 'Mandarin', 'Japanese', 'Arabic',
    ],
    default_type: DEFAULT_TYPE,
  };
}

module.exports = {
  SESSION_TYPES,
  ACTIONS,
  DEFAULT_TYPE,
  DEFAULT_ACTION,
  systemPromptFor,
  classifyQuestion,
  isCodingQuestion,
  technicalTerms,
  groundingBlock,
  explicitLengthRule,
  catalogue,
};
