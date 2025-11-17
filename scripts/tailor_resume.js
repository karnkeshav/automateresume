// scripts/tailor_resume.js
// Uses Node's global fetch (Node 18+ / Node 20). No node-fetch dependency required.

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { marked } = require('marked');
const puppeteer = require('puppeteer');
const argv = require('minimist')(process.argv.slice(2));

// If global fetch is not available for any reason, use undici as a fallback
// (undici is not installed by default; we rely on Node 20 global fetch)
const _fetch = (typeof fetch !== 'undefined') ? fetch : undefined;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY missing in environment.");
  process.exit(1);
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1/models";

const jobTitle = argv["job-title"] || argv.jobTitle || "Software Engineer";
const jobDesc = argv["job-desc"] || argv.jobDesc || argv["job-description"] || "";
const company = argv["company"] || "Company";
const resumePath = argv["resume-path"] || "resumes/Keshav-resume.docx";
const maxIterations = parseInt(argv["max-iterations"] || 1, 10) || 1;

async function extractTextFromDocx(p) {
  const buffer = fs.readFileSync(p);
  const result = await mammoth.extractRawText({ buffer });
  return result.value.replace(/\r/g, "").trim();
}

async function callGemini(prompt, options = {}) {
  // Use global fetch
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available in this Node runtime. Ensure Node 18+ or change the script to include a fetch polyfill.');
  }

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxOutputTokens ?? 4096
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    throw new Error(`Invalid JSON from Gemini: ${res.status} ${text}`);
  }

  if (!res.ok) {
    throw new Error("Gemini API Error: " + JSON.stringify(json));
  }

  // Common response shapes
  if (json.output_text) return json.output_text;

  if (json.candidates && json.candidates[0]) {
    const c = json.candidates[0];
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) {
      return c.content.map(p => (typeof p === 'string' ? p : (p.text || JSON.stringify(p)))).join("\n");
    }
    if (c.output && Array.isArray(c.output)) {
      return c.output.map(o => (o.text || JSON.stringify(o))).join("\n");
    }
    if (c.message && c.message.content) {
      if (typeof c.message.content === "string") return c.message.content;
      if (Array.isArray(c.message.content)) return c.message.content.map(x => x.text || JSON.stringify(x)).join("\n");
    }
  }

  if (json.output && Array.isArray(json.output) && json.output[0] && Array.isArray(json.output[0].content)) {
    return json.output[0].content.map(p => p.text || JSON.stringify(p)).join("\n");
  }

  return JSON.stringify(json);
}

function buildTailorPrompt(resumeText, jobTitle, jobDesc) {
  return `
You are an expert resume writer. Tailor the following resume to the job role.

=== ORIGINAL RESUME ===
${resumeText}
=== END OF RESUME ===

Job title: ${jobTitle}
Job description:
${jobDesc}

Create a resume in Markdown:
- Focus on measurable achievements
- Improve clarity
- Use ATS-friendly bullet points
- Keep it max 2 pages
- ONLY output the resume in Markdown.
`;
}

function buildRecruiterPrompt(tailored, company, jobTitle, jobDesc) {
  return `
You are a recruiter at ${company}. Review the candidate's resume for the job: ${jobTitle}.

Job description:
${jobDesc}

Candidate resume:
${tailored}

List weaknesses or gaps in JSON: 
{
  "gaps": [
    {"issue":"...", "importance":"...", "fix":"..."}
  ]
}
`;
}

function buildFixPrompt(tailored, gaps) {
  return `
You are a senior resume expert. Improve the resume below using the gap analysis.

Resume:
${tailored}

Gaps JSON:
${gaps}

Return ONLY the final improved resume in Markdown.
`;
}

async function renderPDF(md, pathOut) {
  const templatePath = path.join(__dirname, "..", "templates", "resume_template.html");
  let htmlTemplate = "<html><body>{{CONTENT}}</body></html>";

  if (fs.existsSync(templatePath)) {
    htmlTemplate = fs.readFileSync(templatePath, "utf8");
  }

  const html = htmlTemplate.replace("{{CONTENT}}", marked(md)).replace("{{TITLE}}", "Tailored Resume");

  if (!fs.existsSync("output")) fs.mkdirSync("output");
  fs.writeFileSync("output/rendered.html", html);

  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({ path: pathOut, format: "A4", printBackground: true });
  await browser.close();
}

(async () => {
  try {
    const absResume = path.isAbsolute(resumePath) ? resumePath : path.join(process.cwd(), resumePath);

    if (!fs.existsSync(absResume)) {
      throw new Error("Resume file not found: " + absResume);
    }

    if (!fs.existsSync("output")) fs.mkdirSync("output");

    console.log("Extracting resume text...");
    const resumeText = await extractTextFromDocx(absResume);

    console.log("Stage 1: Tailoring resume...");
    const tailored = await callGemini(buildTailorPrompt(resumeText, jobTitle, jobDesc));
    fs.writeFileSync("output/tailored_stage1.md", tailored);

    console.log("Stage 2: Recruiter review...");
    const gaps = await callGemini(buildRecruiterPrompt(tailored, company, jobTitle, jobDesc));
    fs.writeFileSync("output/recruiter_gaps.json", gaps);

    console.log("Stage 3: Fixing resume...");
    const improved = await callGemini(buildFixPrompt(tailored, gaps));
    fs.writeFileSync("output/tailored_final.md", improved);

    console.log("Stage 4: Rendering PDF...");
    await renderPDF(improved, "output/tailored_final.pdf");

    console.log("DONE. Check output/");
  } catch (err) {
    console.error("ERROR:", err);
    if (!fs.existsSync("output")) fs.mkdirSync("output");
    fs.writeFileSync("output/error.txt", String(err));
    process.exit(1);
  }
})();
