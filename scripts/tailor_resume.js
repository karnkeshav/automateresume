// scripts/tailor_resume.js
// Full resume-tailoring script with robust Gemini calls (tries candidateConfig then minimal payload).
// Dependencies (package.json): mammoth, marked, minimist, puppeteer
// Env required: GEMINI_API_KEY (AI Studio key). Optional: GEMINI_MODEL (default gemini-2.5-flash)

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { marked } = require('marked');
const puppeteer = require('puppeteer');
const argv = require('minimist')(process.argv.slice(2));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY missing in environment.');
  process.exit(1);
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models';
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '4096', 10);

const jobTitle = argv['job-title'] || argv.jobTitle || 'Software Engineer';
const jobDesc = argv['job-desc'] || argv.jobDesc || argv['job-description'] || '';
const company = argv.company || 'Company';
const resumePathInput = argv['resume-path'] || 'resumes/Keshav-resume.docx';
const maxIterations = parseInt(argv['max-iterations'] || 1, 10) || 1;

// --- helper: find resume file robustly ---
function findResumeFile(requestedPath) {
  const candidates = [];

  if (path.isAbsolute(requestedPath)) {
    candidates.push(requestedPath);
  } else {
    candidates.push(path.join(process.cwd(), requestedPath));
  }

  // Try common folder variations
  if (!requestedPath.startsWith('resumes/') && !requestedPath.startsWith('resume/')) {
    candidates.push(path.join(process.cwd(), 'resumes', requestedPath));
    candidates.push(path.join(process.cwd(), 'resume', requestedPath));
  } else {
    // swap between resume/resumes
    candidates.push(path.join(process.cwd(), requestedPath.replace(/^resumes\//, 'resume/')));
    candidates.push(path.join(process.cwd(), requestedPath.replace(/^resume\//, 'resumes/')));
  }

  // basename variants
  const base = path.basename(requestedPath);
  candidates.push(path.join(process.cwd(), base));
  candidates.push(path.join(process.cwd(), base.toLowerCase()));
  candidates.push(path.join(process.cwd(), base.replace(/-/g, '_')));

  // Deduplicate preserving order
  const seen = new Set();
  const uniq = candidates.filter(p => {
    if (!p) return false;
    const key = p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const p of uniq) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// --- extract text from DOCX using mammoth ---
async function extractTextFromDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value.replace(/\r/g, '').trim();
}

// --- call Gemini v1 generateContent robustly ---
// Tries two payload shapes:
// 1) with candidateConfig: { contents: [...], candidateConfig: { temperature, maxOutputTokens } }
// 2) minimal: { contents: [...] }
async function callGemini(prompt, opts = {}) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available in this Node runtime. Use Node 18+ (GitHub Actions uses Node 20).');
  }

  const model = opts.model || GEMINI_MODEL;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const candidateConfig = {
    temperature: opts.temperature ?? 0.2,
    // Some endpoints use maxOutputTokens, some use maxTokens; keep value but place inside candidateConfig
    maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS
  };

  const contents = [
    {
      parts: [{ text: prompt }]
    }
  ];

  // Helper to send request and return {ok,json,status,text}
  async function postJson(bodyObj) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    let json = null;
    let text = null;
    try { json = await res.json(); } catch (e) { text = await res.text().catch(() => null); }
    return { ok: res.ok, status: res.status, json, text };
  }

  // First attempt: candidateConfig style
  const body1 = {
    contents,
    candidateConfig
  };

  let attempt1 = await postJson(body1);
  if (attempt1.ok) {
    return extractTextFromResponseJson(attempt1.json);
  }

  // If failed due to unknown fields mentioning temperature or maxOutputTokens, fall back
  const errText = attempt1.json ? JSON.stringify(attempt1.json) : (attempt1.text || `status ${attempt1.status}`);
  if (attempt1.status === 400 && /Unknown name.*temperature|Unknown name.*maxOutputTokens/i.test(errText)) {
    // Try minimal payload
    console.warn('Gemini rejected candidateConfig payload; retrying with minimal payload (contents only).');
    const body2 = { contents };
    const attempt2 = await postJson(body2);
    if (attempt2.ok) return extractTextFromResponseJson(attempt2.json);

    // if still fails, throw first error for debugging
    throw new Error(`Gemini API error (both attempts failed). First: ${errText}. Second: ${attempt2.json ? JSON.stringify(attempt2.json) : attempt2.text}`);
  }

  // If error is not the unknown-field case, but attempt1 failed, try minimal payload anyway (some endpoints accept minimal)
  const attempt2 = await postJson({ contents });
  if (attempt2.ok) return extractTextFromResponseJson(attempt2.json);

  // else throw helpful error
  const msg1 = attempt1.json ? JSON.stringify(attempt1.json) : attempt1.text;
  const msg2 = attempt2.json ? JSON.stringify(attempt2.json) : attempt2.text;
  throw new Error(`Gemini API error. Attempt1: ${msg1}. Attempt2: ${msg2}`);
}

// Helper to extract text content from common Gemini response shapes
function extractTextFromResponseJson(json) {
  if (!json) return '';

  if (typeof json.output_text === 'string') return json.output_text;

  if (Array.isArray(json.candidates) && json.candidates[0]) {
    const cand = json.candidates[0];
    if (typeof cand.content === 'string') return cand.content;
    if (Array.isArray(cand.content)) {
      return cand.content.map(p => (typeof p === 'string' ? p : (p.text || JSON.stringify(p)))).join('\n');
    }
    if (Array.isArray(cand.output)) {
      return cand.output.map(o => (o.text || JSON.stringify(o))).join('\n');
    }
    if (cand.message && cand.message.content) {
      if (typeof cand.message.content === 'string') return cand.message.content;
      if (Array.isArray(cand.message.content)) return cand.message.content.map(c => (c.text || JSON.stringify(c))).join('\n');
    }
  }

  if (Array.isArray(json.output) && json.output[0] && Array.isArray(json.output[0].content)) {
    return json.output[0].content.map(p => p.text || JSON.stringify(p)).join('\n');
  }

  // fallback
  return JSON.stringify(json);
}

// --- prompts builders ---
function buildTailorPrompt(resumeText, jobTitle, jobDesc) {
  return `
You are an expert resume writer. Tailor the following existing resume text to the job.

=== EXISTING RESUME TEXT START ===
${resumeText}
=== EXISTING RESUME TEXT END ===

Job title: ${jobTitle}
Job description:
${jobDesc}

Task:
1) Produce a tailored resume (in Markdown) that emphasizes relevant skills, achievements, and keywords matching the job description.
2) Keep it concise — 1-2 pages equivalent, with bullet points for responsibilities & achievements.
3) Where possible, quantify achievements (use reasonable placeholders if specific numbers are not present).
4) Use headings: Name, Contact (placeholders allowed), Summary, Skills, Experience (with bullets), Education, Certifications.
5) Return ONLY the resume in Markdown (no analysis).
`;
}

function buildRecruiterReviewPrompt(tailoredResumeMarkdown, company, jobTitle, jobDesc) {
  return `
You are now a recruiter at ${company} reviewing a candidate for the role: ${jobTitle}.

Job description:
${jobDesc}

Candidate tailored resume:
${tailoredResumeMarkdown}

Task:
1) As the recruiter, list up to 10 specific gaps or weaknesses where the candidate does not match the job (missing skills, experience, unclear quantification, seniority mismatch).
2) For each gap, explain why it's important for the role and give a one-sentence suggestion on how to fix it in the resume or cover letter.
Return the response as JSON with fields: { "gaps": [ { "issue": "...", "importance": "...", "fix": "..." } ] }
`;
}

function buildFixPrompt(tailoredResumeMarkdown, gapsJson) {
  return `
You are an expert resume writer. Given the tailored resume below and the recruiter's identified gaps, update and improve the resume to address the gaps.

Tailored resume:
${tailoredResumeMarkdown}

Recruiter gaps (JSON):
${gapsJson}

Task:
1) Modify the resume to address the gaps as best as possible. If quantification is invented, mark numbers with parentheses and note they should be replaced.
2) Return only the final updated resume in Markdown.
`;
}

// --- render Markdown to PDF using puppeteer ---
async function saveMarkdownAsPdf(markdownText, outPdfPath, title = 'Tailored Resume') {
  const templatePath = path.join(__dirname, '..', 'templates', 'resume_template.html');
  const template = fs.existsSync(templatePath)
    ? fs.readFileSync(templatePath, 'utf8')
    : '<!doctype html><html><head><meta charset="utf-8"><title>{{TITLE}}</title></head><body>{{CONTENT}}</body></html>';

  const htmlResume = marked.parse(markdownText);
  const filled = template.replace('{{CONTENT}}', htmlResume).replace('{{TITLE}}', title);

  if (!fs.existsSync(path.join(process.cwd(), 'output'))) fs.mkdirSync(path.join(process.cwd(), 'output'));
  fs.writeFileSync(path.join(process.cwd(), 'output', 'tailored_resume_rendered.html'), filled, 'utf8');

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(filled, { waitUntil: 'networkidle0' });
  await page.pdf({ path: outPdfPath, format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm' } });
  await browser.close();
}

// --- main flow ---
(async () => {
  try {
    // ensure output folder
    if (!fs.existsSync(path.join(process.cwd(), 'output'))) fs.mkdirSync(path.join(process.cwd(), 'output'));

    // resolve resume
    const resolvedResume = findResumeFile(resumePathInput || 'resumes/Keshav-resume.docx');
    if (!resolvedResume) {
      console.error('Resume file not found. Tried common locations. Please ensure your resume is at resumes/Keshav-resume.docx or resume/Keshav-resume.docx or at repo root.');
      process.exit(2);
    }
    console.log('Using resume file:', resolvedResume);

    const resumeText = await extractTextFromDocx(resolvedResume);
    console.log(`Extracted resume text length: ${resumeText.length}`);

    // Stage 1: Tailor
    console.log('Calling Gemini: tailoring resume...');
    const tailorPrompt = buildTailorPrompt(resumeText, jobTitle, jobDesc);
    const tailored = await callGemini(tailorPrompt, { temperature: 0.2, maxOutputTokens: 4096 });
    fs.writeFileSync(path.join(process.cwd(), 'output', 'tailored_resume_stage1.md'), tailored, 'utf8');
    console.log('Stage 1 saved.');

    // Stage 2: Recruiter review
    console.log('Calling Gemini: recruiter review for gaps...');
    const reviewPrompt = buildRecruiterReviewPrompt(tailored, company, jobTitle, jobDesc);
    const gapsRaw = await callGemini(reviewPrompt, { temperature: 0.1, maxOutputTokens: 1024 });
    let gapsJson = gapsRaw;
    try {
      const m = gapsRaw.match(/\{[\s\S]*\}/);
      if (m) gapsJson = m[0];
      JSON.parse(gapsJson);
    } catch (e) {
      console.warn('Recruiter gaps response not strict JSON — saving raw text.');
      gapsJson = gapsRaw;
    }
    fs.writeFileSync(path.join(process.cwd(), 'output', 'recruiter_gaps.json.txt'), gapsJson, 'utf8');
    console.log('Stage 2 saved.');

    // Stage 3: Fix gaps
    console.log('Calling Gemini: fixing resume based on gaps...');
    const fixPrompt = buildFixPrompt(tailored, gapsJson);
    const fixedResume = await callGemini(fixPrompt, { temperature: 0.15, maxOutputTokens: 4096 });
    fs.writeFileSync(path.join(process.cwd(), 'output', 'tailored_resume_final.md'), fixedResume, 'utf8');
    console.log('Stage 3 saved.');

    // Render PDF
    const outPdf = path.join(process.cwd(), 'output', 'tailored_resume_final.pdf');
    console.log('Rendering final PDF to', outPdf);
    await saveMarkdownAsPdf(fixedResume, outPdf, `${jobTitle} - Tailored Resume`);

    console.log('Done. Artifacts in ./output/');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    try {
      if (!fs.existsSync(path.join(process.cwd(), 'output'))) fs.mkdirSync(path.join(process.cwd(), 'output'));
      fs.writeFileSync(path.join(process.cwd(), 'output', 'error.txt'), String(err), 'utf8');
    } catch (e) {}
    process.exit(10);
  }
})();
