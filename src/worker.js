// Cloudflare Worker: serves the static app and two AI endpoints.
//
//   POST /api/generate  — draft homework questions with Claude
//   POST /api/mark      — mark a submission (typed answers or photos) with Claude
//
// Every request must carry the signed-in user's Supabase access token. The Worker
// reads and writes Supabase *as that user*, so row-level security decides what it
// can touch. The only secret it holds is ANTHROPIC_API_KEY.

const SUPABASE_URL = 'https://veoxasldburbztzucyrn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Gwnaqzgzz-Abvn5hiQvhsw_32P5goIo';
const MODEL = 'claude-sonnet-5-5';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    try {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'The AI key has not been set up yet (ANTHROPIC_API_KEY).' }, 503);
      const jwt = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!jwt) return json({ error: 'Not signed in' }, 401);
      const db = supabase(jwt);
      const level = await db.rpc('school_access_level');
      if (![1, 2, 4].includes(level)) return json({ error: 'Only teachers can use this' }, 403);

      const body = await request.json();
      if (url.pathname === '/api/generate') return json(await generate(env, db, body));
      if (url.pathname === '/api/mark') return json(await mark(env, db, body));
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

/* ---------- Drafting ---------- */

async function generate(env, db, { class_id, topic, count, types, notes }) {
  count = Math.max(1, Math.min(20, Number(count) || 8));
  const allowed = ['number', 'short_text', 'multiple_choice'];
  types = (Array.isArray(types) ? types : allowed).filter((t) => allowed.includes(t));
  if (!types.length) types = ['number'];
  if (!topic || String(topic).length > 300) throw httpError('Give a topic (up to 300 characters)', 400);

  const [cls] = await db.get(`classes?class_id=eq.${Number(class_id)}&select=class_id,year_group,name`);
  if (!cls) throw httpError('Class not found', 404);
  const year = cls.year_group === 0 ? 'Reception' : `Year ${cls.year_group}`;

  const tool = {
    name: 'create_homework',
    description: 'Return the homework sheet.',
    input_schema: {
      type: 'object',
      required: ['title', 'objective', 'questions'],
      properties: {
        title: { type: 'string', description: 'Short, friendly title, e.g. "Equivalent fractions"' },
        objective: { type: 'string', description: 'The National Curriculum objective this practises, starting with the year, e.g. "Y4: recognise and show, using diagrams, families of common equivalent fractions"' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['prompt', 'answer_type', 'correct_answer', 'marks'],
            properties: {
              prompt: { type: 'string' },
              answer_type: { type: 'string', enum: types },
              options: { type: 'array', items: { type: 'string' }, description: 'Only for multiple_choice: 3 or 4 options' },
              correct_answer: { type: 'string', description: 'For number: just the number. For multiple_choice: exactly one of the options.' },
              marks: { type: 'integer', minimum: 1, maximum: 3 },
              working_space: { type: 'boolean', description: 'True if the pupil should show working' },
            },
          },
        },
      },
    },
  };

  const prompt = `Write a maths homework sheet for a ${year} class in an English primary school.
Topic: ${topic}
Number of questions: ${count}
Allowed answer types: ${types.join(', ')}
${notes ? `Teacher's notes: ${String(notes).slice(0, 1000)}` : ''}

Rules:
- Follow the National Curriculum for England for ${year}; use British spelling and £/metric units.
- Pupils may answer on paper, so every question must have one clear answer that fits in a small box. No questions needing drawings.
- Start easier and build up; mix in a word problem or two.
- Keep wording short and age-appropriate. Use plain text only (write fractions like 3/4).
- correct_answer must be exactly right. For number answers give only the number (no units).`;

  const out = await claude(env, [{ role: 'user', content: prompt }], tool, 4000);
  const questions = (out.questions || []).slice(0, count).map((q, i) => ({
    position: i + 1,
    prompt: String(q.prompt || '').slice(0, 1000),
    answer_type: types.includes(q.answer_type) ? q.answer_type : types[0],
    options: q.answer_type === 'multiple_choice' && Array.isArray(q.options) ? q.options.slice(0, 6).map(String) : null,
    correct_answer: String(q.correct_answer ?? ''),
    marks: Math.max(1, Math.min(3, Number(q.marks) || 1)),
    working_space: !!q.working_space,
  }));
  return { title: String(out.title || topic).slice(0, 120), objective: String(out.objective || '').slice(0, 400), questions };
}

/* ---------- Marking ---------- */

async function mark(env, db, { submission_id }) {
  const id = Number(submission_id);
  const [sub] = await db.get(`homework_submissions?submission_id=eq.${id}&select=*,homework(homework_id,title,subject,topic,objective,class_id,classes(year_group))`);
  if (!sub) throw httpError('Submission not found', 404);
  if (!['submitted', 'marked'].includes(sub.status)) throw httpError('Nothing has been handed in yet', 400);
  const questions = await db.get(`homework_questions?homework_id=eq.${sub.homework_id}&order=position`);
  const typed = sub.channel === 'online' ? await db.get(`homework_answers?submission_id=eq.${id}&select=question_id,answer_text`) : [];
  const typedBy = Object.fromEntries(typed.map((a) => [a.question_id, a.answer_text]));
  const yg = sub.homework?.classes?.year_group;

  const content = [];
  if (sub.channel === 'photo') {
    for (const path of sub.photo_paths || []) content.push(await db.file('homework-uploads', path));
  }
  const qText = questions.map((q) => {
    let line = `Q${q.position} [question_id ${q.question_id}, ${q.marks} mark${q.marks > 1 ? 's' : ''}, ${q.answer_type}]: ${q.prompt}`;
    if (q.options) line += `\n   Options: ${q.options.join(' | ')}`;
    line += `\n   Correct answer: ${q.correct_answer}`;
    if (sub.channel === 'online') line += `\n   Pupil typed: ${typedBy[q.question_id] ?? '(blank)'}`;
    return line;
  }).join('\n');

  content.push({
    type: 'text',
    text: `You are helping a primary school teacher mark homework for a ${yg === 0 ? 'Reception' : `Year ${yg}`} pupil. The teacher will review your marking.
Homework: ${sub.homework.title}${sub.homework.objective ? ` (${sub.homework.objective})` : ''}
${sub.channel === 'photo' ? 'The pupil answered on the printed sheet; the attached image(s) are photos or scans of it. Read each answer from its box. Ignore crossed-out work.' : 'The pupil typed their answers online.'}

${qText}

For every question:
- pupil_answer: what the pupil wrote, exactly as you read it ("" if blank or unreadable).
- correct: true only if it matches the correct answer. Accept equivalent forms (0.5 = 1/2 = 2/4) unless the question asks for a specific form; accept missing or correct units; ignore spelling slips in number words.
- confidence: 0 to 1, how sure you are of BOTH the reading and the verdict. Use below 0.8 for messy or ambiguous handwriting, faint photos, or anything you had to guess.
- note: a few words for the teacher only if useful (e.g. "wrote 3/4 then crossed out", "likely misconception: added denominators").
Also give a one or two sentence summary for the teacher, including any pattern in the mistakes.`,
  });

  const tool = {
    name: 'record_marks',
    description: 'Record the marking.',
    input_schema: {
      type: 'object',
      required: ['answers', 'summary'],
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['question_id', 'pupil_answer', 'correct', 'confidence'],
            properties: {
              question_id: { type: 'integer' },
              pupil_answer: { type: 'string' },
              correct: { type: 'boolean' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              note: { type: 'string' },
            },
          },
        },
        summary: { type: 'string' },
        photos_unusable: { type: 'boolean', description: 'True if the photos cannot be read at all' },
      },
    },
  };

  const out = await claude(env, [{ role: 'user', content }], tool, 3000);
  const byQ = new Map((out.answers || []).map((a) => [Number(a.question_id), a]));
  const rows = questions.map((q) => {
    const a = byQ.get(q.question_id) || { pupil_answer: '', correct: false, confidence: 0, note: 'Not marked by AI' };
    const correct = !!a.correct;
    return {
      submission_id: id,
      question_id: q.question_id,
      answer_text: sub.channel === 'online' ? (typedBy[q.question_id] ?? '') : String(a.pupil_answer ?? '').slice(0, 500),
      ai_correct: correct,
      ai_confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
      ai_note: a.note ? String(a.note).slice(0, 300) : null,
      teacher_correct: null,
      marks_awarded: correct ? q.marks : 0,
    };
  });
  await db.upsert('homework_answers', rows, 'submission_id,question_id');
  const score = rows.reduce((s, r) => s + r.marks_awarded, 0);
  const max = questions.reduce((s, q) => s + q.marks, 0);
  await db.patch(`homework_submissions?submission_id=eq.${id}`, {
    status: 'marked', marked_at: new Date().toISOString(), score, max_score: max,
    ai_summary: (out.photos_unusable ? 'Photos could not be read. ' : '') + String(out.summary || '').slice(0, 1000),
  });
  return { score, max_score: max, answers: rows, summary: out.summary, photos_unusable: !!out.photos_unusable };
}

/* ---------- Claude ---------- */

// Newer models don't allow forcing a specific tool, so we offer the one tool, tell the
// model to use it, and fall back to reading JSON from the text reply if it doesn't.
async function claude(env, messages, tool, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || MODEL,
      max_tokens: maxTokens,
      system: `Always respond by calling the ${tool.name} tool exactly once with your complete result. Do not reply with plain text.`,
      tools: [tool],
      tool_choice: { type: 'auto' },
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw httpError(`AI error: ${data?.error?.message || res.status}`, 502);
  const use = (data.content || []).find((c) => c.type === 'tool_use' && c.name === tool.name);
  if (use) return use.input;
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw httpError('The AI did not return a usable result. Please try again.', 502);
}

/* ---------- Supabase as the signed-in user ---------- */

function supabase(jwt) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
  const check = async (res) => {
    if (!res.ok) {
      const t = await res.text();
      let msg = t;
      try { msg = JSON.parse(t).message || t; } catch {}
      throw httpError(`Database: ${msg}`, res.status === 401 ? 401 : 400);
    }
    return res;
  };
  return {
    async rpc(fn, args = {}) {
      const res = await check(await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) }));
      return res.json();
    },
    async get(path) {
      return (await check(await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers }))).json();
    },
    async upsert(table, rows, onConflict) {
      await check(await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
      }));
    },
    async patch(path, body) {
      await check(await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(body),
      }));
    },
    // Fetch an uploaded file and turn it into a Claude content block
    async file(bucket, path) {
      const res = await check(await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers }));
      const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      const b64 = toBase64(await res.arrayBuffer());
      return type === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: type, data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: type, data: b64 } };
    },
  };
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function httpError(message, status) { const e = new Error(message); e.status = status; return e; }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
