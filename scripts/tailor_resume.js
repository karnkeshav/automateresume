// scripts/tailor_resume.js
// Reads DOCX resume, calls Gemini generateContent (v1), performs recruiter review and fixes,
// renders final Markdown to PDF. Writes artifacts to ./output/
//
// Requirements (package.json): mammoth, marked, puppeteer, node-fetch, minimist
// Make sure GEMINI_API_KEY is set in env (GitHub Secrets).
//
// Usage (example):
// node scripts/tailor_resume.js --job-title "SRE" --job-desc "..." --company "Acme" --resume-path "resumes/Keshav-resume.docx"

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const mammoth = require('mammoth');
const { marked } = require('marked');
const puppeteer = require('puppeteer');
const argv = require('minimist')(process.argv.slice(2));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is required.');
  process.exit(1);
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models';

const jobTitle = argv['job-title'] || argv.jobTitle || 'Software Engineer';
const jobDesc = argv['job-desc'] || argv.jobDesc || argv['job-description'] || '';
const company = argv.company || 'Company';
const resumePath = argv['resume-path'] || 'resumes/Keshav-resume.docx';
const maxIterations = parseInt(argv['max-iterations'] || 1, 10) || 1;
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || 2048, 10);

async function extractTextFromDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value.replace(/\r/g, '').trim();
}

async function callGemini(prompt, opts = {}) {
  const model = opts.model || GEMINI_MODEL;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`Gemini API error ${res.status}: ${message}`);
  }

  // Extract text from common shapes
  if (json && typeof json.output_text === 'string') return json.output_text;

  if (json && Array.isArray(json.candidates) && json.candidates[0]) {
    const cand = json.candidates[0];
    if (typeof cand.content === 'string') return cand.content;
    if (Array.isArray(cand.content)) {
      const parts = cand.content.map(p => (typeof p === 'string' ? p : (p.text || JSON.stringify(p)))).join('\n');
      if (parts.trim()) return parts;
    }
    if (cand.output && Array.isArray(cand.output)) {
      const out = cand.output.map(o => (o.text || JSON.stringify(o))).join('\n');
      if (out.trim()) return out;
    }
    if (cand.message && cand.message.content) {
      if (typeof cand.message.content === 'string') return cand.message.content;
      if (Array.isArray(cand.message.content)) {
        return cand.message.content.map(c => (c.text || JSON.stringify(c))).join('\n');
      }
    }
  }

  if (json && Array.isArray(json.output) && json.output[0] && Array.isArray(json.output[0].content)) {
    const outParts = json.output[0].content.map(p => p.text || JSON.stringify(p)).join('\n');
    if (outParts.trim()) return outParts;
  }

  return JSON.stringify(json);
}

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
4) Use headings: Name, Contact (leave placeholders), Summary, Skills, Experience (with bullets), Education, Certifications (if any).
5) Return ONLY the resume in Markdown (no analysis, no extra commentary).
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
1) As the recruiter, list up to 10 specific gaps or weaknesses where the candidate does not match the job (be explicit: missing skills, missing experience, unclear quantification, mismatched seniority).
2) For each gap, explain why it's important for this role, and give a short actionable suggestion (one sentence) on how to fix it in the resume or cover letter.
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
1) Modify the resume to address the gaps as best as possible. If the fix requires adding quantification that is not present, add conservative phrasing and mark any invented numbers with parentheses and a note that they should be replaced.
2) Return only the final updated resume in Markdown.
`;
}

async function saveMarkdownAsPdf(markdownText, outPdfPath, title = 'Tailored Resume') {
  const templatePath = path.join(__dirname, '..', 'templates', 'resume_template.html');
  const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '<html><body>{{CONTENT}}</body></html>';
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

(async () => {
  try {
    const absResume = path.isAbsolute(resumePath) ? resumePath : path.join(process.cwd(), resumePath);
    if (!fs.existsSync(absResume)) {
      console.error('Resume file not found at', absResume);
      process.exit(2);
    }

    console.log('Extracting text from', absResume);
    const resumeText = await extractTextFromDocx(absResume);
    console.log(`Extracted resume text length: ${resumeText.length}`);

    // Stage 1: Tailor
    console.log('Calling Gemini to tailor resume...');
    const tailorPrompt = buildTailorPrompt(resumeText, jobTitle, jobDesc);
    const tailored = await callGemini(tailorPrompt, { temperature: 0.2, maxOutputTokens: 4096 });
    if (!fs.existsSync('./output')) fs.mkdirSync('./output');
    fs.writeFileSync('./output/tailored_resume_stage1.md', tailored, 'utf8');
    console.log('Stage 1 tailored resume saved.');

    // Stage 2: Recruiter review
    console.log('Calling Gemini to role-play recruiter and identify gaps...');
    const reviewPrompt = buildRecruiterReviewPrompt(tailored, company, jobTitle, jobDesc);
    const gapsRaw = await callGemini(reviewPrompt, { temperature: 0.1, maxOutputTokens: 1024 });
    let gapsJson = gapsRaw;
    try {
      const m = gapsRaw.match(/\{[\s\S]*\}/);
      if (m) gapsJson = m[0];
      JSON.parse(gapsJson);
    } catch (e) {
      console.warn('Warning: could not parse recruiter gaps strictly as JSON; saving raw text.');
      gapsJson = gapsRaw;
    }
    fs.writeFileSync('./output/recruiter_gaps.json.txt', gapsJson, 'utf8');
    console.log('Recruiter gaps saved.');

    // Stage 3: Fix gaps and finalize
    console.log('Calling Gemini to fix gaps and produce final resume...');
    const fixPrompt = buildFixPrompt(tailored, gapsJson);
    const fixedResume = await callGemini(fixPrompt, { temperature: 0.15, maxOutputTokens: 4096 });
    fs.writeFileSync('./output/tailored_resume_final.md', fixedResume, 'utf8');

    // Stage 4: Render PDF
    const outPdf = path.join(process.cwd(), 'output', 'tailored_resume_final.pdf');
    console.log('Rendering PDF to', outPdf);
    await saveMarkdownAsPdf(fixedResume, outPdf, `${jobTitle} - Tailored Resume`);

    console.log('All done. Artifacts written to ./output/');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    try { if (!fs.existsSync('./output')) fs.mkdirSync('./output'); fs.writeFileSync('./output/error.txt', String(err)); } catch (e) {}
    process.exit(10);
  }
})();
