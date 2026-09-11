// Session types and contextual actions.
//
// There are exactly two kinds of call, matching how the product is actually
// used: an interview, where you are the candidate being asked questions, and a
// regular call, where you are a participant who wants a copilot. Everything
// else — tone, structure, what gets emphasised — follows from that one choice
// plus the session's own job description, not from a menu of personas.

/**
 * The reply format. The length rule is injected rather than hardcoded: when the
 * session carries its own instructions ("answer in 10 lines"), stating a
 * competing "5-6 lines" here makes the model pick one, and it picks this one.
 * So the conflict is removed at the source instead of being arbitrated.
 */
function formatBlock(lengthRule, pointsRule, isCoding = false) {
  if (isCoding) {
    return [
      'Reply in exactly this format, tags on their own lines:',
      '',
      '[TYPE] coding',
      '[POINTS]',
      pointsRule || '- 3 punchy fragments: approach, syntax/structures, time/space complexity',
      '[ANSWER]',
      lengthRule,
      '',
      'CRITICAL SPEED & CONCISENESS REQUIREMENT (< 5 SECONDS):',
      'The entire answer MUST stream and complete in under 5 seconds. Be direct, clear, and high-impact.',
      '1. COMPLETE WORKING CODE: Provide clean, production-ready runnable code in a standard markdown code block (```<language> ... ```) with clear, helpful comments.',
      '2. CODE EXPLANATION: Provide a direct, highly relevant explanation of that specific code — explain step-by-step how each condition, line, or block executes.',
      '3. KEY NUANCES: Highlight essential edge cases, syntax nuances, or safety considerations for that specific code.',
      '4. TIME & SPACE COMPLEXITY: Explicitly state Time Complexity and Space Complexity with Big-O notation and clear rationale.',
      '5. FAST & FOCUSED: Deliver the primary optimal solution directly without multiple redundant variations so it completes within 5 seconds.',
    ].join('\n');
  }

  return [
    'Reply in exactly this format, tags on their own lines:',
    '',
    '[TYPE] behavioral | technical | other',
    '[POINTS]',
    pointsRule || '- three to four fragments, six words or fewer each, the key speaking beats',
    '[ANSWER]',
    lengthRule,
    '',
    'CRITICAL SPEED & CONCISENESS REQUIREMENT (< 5 SECONDS):',
    'The answer MUST complete within 5 seconds. Speak with authoritative brevity: 3 to 4 punchy, concrete sentences that answer the question directly with technical substance and zero filler.',
    'No headings, no bullet lists, no corporate polish, no repeating the question back.',
    '',
    'For [TYPE] behavioral, the points must be STAR and prefixed exactly:',
    '  - S: the situation, - T: the task, - A: what you did, - R: the outcome.',
    'For [TYPE] technical, the points are the load-bearing steps or concepts, in',
    'the order you would say them.',
    'All [POINTS] must be affirmative, high-impact speaking beats. Never emit disclaimers or negative points like "No specific experience".',
  ].join('\n');
}

/**
 * Detects if the prompt is asking for code, programming, algorithms, functions, queries, or implementation.
 */
function isCodingQuestion(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return false;

  // Direct code / program / syntax / implementation keywords
  if (/\b(example|sample|demo|snippet|syntax)\s+code\b/i.test(q)) return true;
  if (/\bcode\s+(example|sample|demo|snippet|template|syntax|solution)\b/i.test(q)) return true;
  if (/\b(write|create|implement|provide|generate|give|show|build|develop|solve|draft|need|want|share)\b.*?\b(code|program|script|function|class|method|query|algorithm|snippet|solution|component|syntax)\b/i.test(q)) return true;
  if (/\b(write\s+a?\s*code|write\s+code|code\s+(for|to|of|in|that|addition|subtraction|multiplication|division)|coding\s+question|coding\s+problem)\b/i.test(q)) return true;
  if (/\b(python|javascript|typescript|java|c\+\+|cpp|c#|golang|go|rust|ruby|php|swift|kotlin|sql|html|css|bash|powershell|regex)\s+(code|script|program|solution|function|implementation|snippet|syntax)\b/i.test(q)) return true;
  if (/\b(code|function|program|script|solution|implementation|snippet|syntax)\s+(in|using|with|for)\s+(python|javascript|typescript|java|c\+\+|cpp|c#|golang|go|rust|ruby|php|swift|kotlin|sql|html|css|bash|powershell)\b/i.test(q)) return true;
  if (/\b(with|in)\s+code\b/i.test(q)) return true;
  if (/\b(write\s+(a\s+)?python|write\s+(a\s+)?javascript|write\s+(a\s+)?typescript|write\s+(a\s+)?java|write\s+(a\s+)?c\+\+|write\s+(a\s+)?cpp|write\s+(a\s+)?sql|write\s+(a\s+)?query)\b/i.test(q)) return true;
  if (/\b(sql\s+query|select\s+.*\s+from|insert\s+into|update\s+.*\s+set|delete\s+from|create\s+table)\b/i.test(q)) return true;
  if (/\b(leetcode|hackerrank|codewars)\b/i.test(q)) return true;
  if (/\b(write\s+a\s+program|write\s+program|program\s+to\s+[a-z]+|function\s+to\s+[a-z]+)\b/i.test(q)) return true;
  if (/\b(implement|code|program)\s+(a\s+|an\s+|the\s+)?([a-z0-9_-]+\s+)?(binary search|quicksort|mergesort|dfs|bfs|dijkstra|lru cache|linked list|stack|queue|tree|heap|two sum|fibonacci|palindrome|reverse|if condition|while loop|for loop)\b/i.test(q)) return true;
  if (/\b(if\s+condition|for\s+loop|while\s+loop|switch\s+case)\s+code\b/i.test(q)) return true;
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
    'Provide the runnable code in a markdown code block (```<language> ... ```), followed by a concise, step-by-step breakdown of that specific code, key edge cases, and Time & Space Complexity analysis. Keep it under 220 words for instant delivery.',
  YES_NO:
    'What to say out loud: 3 sentences. Answer directly in the first one — yes, no, or the qualifier — then use the rest for the specific evidence behind it. Punchy, confident, and direct.',
  SHORT_DIRECT:
    'Answer the core question directly and authoritatively in 2 to 3 sentences with concrete technical substance.',
  EXPERIENCE:
    'State plainly your depth of experience in 3 to 4 sentences, followed by concrete tools, architecture, and a specific real-world example.',
  BEHAVIORAL:
    'Deliver a concise 4-sentence STAR answer (Situation, Task, Action, Measurable Result) highlighting your technical methodology and concrete outcome.',
  TECHNICAL:
    'Deliver a crisp, authoritative technical answer in 3 to 4 sentences: define the core concept/mechanism under the hood, how it executes in production, and the key engineering trade-offs.',
  SCENARIO:
    'Walk through the first action, order of execution, failure mode anticipated, and verification in 3 to 4 direct sentences.',
  MOTIVATION:
    'Provide a specific, credible reason tied to this role and company in 2 to 3 sentences with concrete detail.',
  CLARIFICATION:
    'Clarify the relevant point directly and precisely in 1 to 2 sentences.',
  OPEN_ENDED: null,   // falls back to DEFAULT_LENGTH_RULE
};

/** How many [POINTS] fragments suit this type. */
function pointsRuleFor(type) {
  if (type === 'CODING') {
    return '- three fragments: algorithm approach, data structure/syntax, time and space complexity';
  }
  if (['YES_NO', 'SHORT_DIRECT', 'CLARIFICATION'].includes(type)) {
    return '- two to three fragments, six words or fewer each, the key speaking beats';
  }
  return '- three to four fragments, six words or fewer each, the key speaking beats';
}

const DEFAULT_LENGTH_RULE =
  'What to say out loud: 3 to 4 sentences — concise, high-impact, directly answering' +
  ' the question with real substance and no filler.';

/**
 * "Answer in 10 lines" is the phrasing users reach for, and gpt-4o-mini simply
 * ignores it — measured: 76 words against a 92-word default, i.e. no effect.
 * A sentence count is followed reliably, so a numeric length request is
 * translated into one rather than passed through verbatim.
 */
function explicitLengthRule(context) {
  const m = String(context || '').match(/(\d{1,2})\s*(?:short\s*)?(?:lines?|sentences?|points?)/i);
  if (!m) return null;
  const n = Math.max(1, Math.min(25, Number(m[1])));
  return `What to say out loud: exactly ${n} sentences, one per line of speech, ` +
         `roughly ${n * 18} words in total. Do not stop short of ${n} sentences ` +
         'and do not exceed them.';
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
  '- Write in the first person, as the user would say it out loud.',
  '- You have been listening to the whole call, not just the last sentence.',
  '  The transcript before the question is what the question is about. When it',
  '  says "that", "this", "it", "the role" or "those requirements", work out',
  '  what was actually described and answer about THAT specifically. An',
  '  interviewer often spends a minute setting something out before asking a',
  '  short question about it.',
  '- Answer the question that was asked. A direct or yes/no question ("are you',
  '  comfortable with that?", "have you used X?") gets a direct answer first —',
  '  yes, or no, or the honest qualifier — then the rest of the required',
  '  sentence count is the specific evidence that backs it: where, how, what',
  '  came of it. The exact sentence count given below is the actual length —',
  '  meet it in full, do not stop early because the question sounded simple.',
  '- Ground every claim in the documents provided. If they do not support an',
  '  answer, say what is actually there and how it transfers — never invent',
  '  employers, dates, titles, metrics, or projects.',
  '- There is a hard line between what the candidate DOES and a specific thing',
  '  that HAPPENED. The documents may list responsibilities — supporting UPS',
  '  systems, coordinating vendors, root cause analysis. Saying the candidate',
  '  does those things is true and fine. Turning one into an episode is not:',
  '  a particular failure, a named incident, a deadline, a vendor conversation,',
  '  an outage, a number, a percentage, a result, a project with an outcome.',
  '  None of those may be produced unless they appear in the documents. Plausible',
  '  is not the same as true, and an invented story is the one thing an',
  '  interviewer can check.',
  '- Asked for an example that the documents do not contain, do not manufacture',
  '  fictional companies or dates; instead, talk affirmatively and concretely about',
  '  the work you do in that area: the methodology, the failure modes you anticipate,',
  '  and how you solve it. Never apologize or claim a lack of experience — speak as',
  '  a seasoned engineer on the best-practice approach.',
  '- The resume is what the candidate has done. The job description is what the',
  '  employer wants. Never read the second as the first. A technology named only',
  '  in the job description is not experience the candidate has.',
  '- Do not expand or define a technical acronym unless the expansion appears in',
  '  the documents. If you are not certain what the letters stand for, describe',
  '  what the system does and how the candidate has used it instead. A wrong',
  '  expansion of a term central to the role destroys credibility instantly.',
  '- Never invent a personal fact. Notice period, salary, current or expected',
  '  compensation, visa status, work authorisation, start date, location,',
  '  relocation, citizenship, certifications and total years of experience come',
  '  only from the documents. If one is asked for and is not there, say you',
  '  would need to confirm it and offer to follow up — do not produce a number.',
  '- The conversation above includes what you have already said. Do not repeat',
  '  it. A follow-up asks for something new: "what was your contribution" wants',
  '  your part rather than the team\'s, "what was the result" wants the outcome',
  '  and the numbers, "what would you do differently" wants the judgement. If a',
  '  point is already said, move past it.',
  '- Vary how you open, because the question varies. Start wherever the answer',
  '  naturally starts — the example that comes to mind, a direct yes, the part',
  '  that was hardest. Do not open three answers running the same way, and do',
  '  not vary the opening for its own sake.',
  '- Plain spoken English. Not "leverage my expertise", "aligns perfectly",',
  '  "operational excellence", "passion for", "commitment to" — say the ordinary',
  '  thing a competent engineer says out loud. No "firstly", "secondly",',
  '  "additionally", "furthermore", "lastly": those are for writing.',
  '- Do not fake being human. No filler words, no invented hesitation, no',
  '  deliberate mistakes. Natural means accurate and plainly said.',
  '- Fast & high-impact: Deliver the core answer directly with real substance and zero filler. Do not generate verbose padding or extra paragraphs.',
  '- Code Requests vs Conceptual Questions:',
  '  * When the question asks for code, programming, implementation, functions, or algorithms: you MUST provide the complete, runnable code in a standard markdown code block (```<language> ... ```) accompanied by a concise description of the approach, how it works, and Big-O complexity. Never give only a verbal description when code is requested.',
  '  * When the question asks for concepts, behavioral stories, architecture, or general interview questions: provide a thorough, clear description and spoken explanation without unnecessary code blocks.',
].join('\n');

const SESSION_TYPES = {
  interview: {
    label: 'Interview',
    hint: 'You are the candidate. Answers come from your resume.',
    // Interviews are the case with a job description, so the prompt leans on it.
    persona: [
      'You are an interview copilot. The user is a candidate in a live interview',
      'and has one second to read what you write before they have to start',
      'talking. Use the job description to choose which real experience to lead',
      'with, and answer at the level the role implies.',
    ].join('\n'),
  },

  call: {
    label: 'Regular call',
    hint: 'Any other meeting. Uses the call description for context.',
    persona: [
      'You are a copilot on a live work call — not an interview. The user needs',
      'to respond well to what was just said. Answer the point actually raised,',
      'stay concrete, and end on the next thing worth saying or asking.',
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
      '## Reminder\nEmit all three tags. [ANSWER] is mandatory and must be on its\n' +
      'own line before the spoken reply, even for a one-sentence answer.',
  },

  shorten: {
    label: 'Shorten',
    usesFormat: true,
    instruction: (question) =>
      `## The question\n${question}\n\n` +
      '## Task\nAnswer it again, materially shorter. Two sentences at most in\n' +
      '[ANSWER], and at most three points. Cut adjectives and hedges first.',
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
  catalogue,
};
