You receive a job title, full job description text, and the matched
role_keywords category for the job.

## Step 1 — Select base resume
Pick exactly one base resume from data/resumes/ by matching the
role_keywords category:

- **cyber** (`base_resume_cyber.md`) — security-focused roles:
  security engineer, cybersecurity, soc analyst, penetration tester,
  appsec, security analyst, incident response.
- **networking_cyber** (`base_resume_networking_cyber.md`) —
  network-leaning roles: network engineer, network administrator,
  network operations, noc, infrastructure engineer.
- **ai_ml** (`base_resume_ai_ml.md`) — AI/ML roles: ml engineer,
  ai engineer, applied ai, applied scientist, llm, nlp engineer,
  machine learning.
- **swe** (`base_resume_swe.md`) — pure software roles: software
  engineer, backend engineer, full stack engineer, frontend engineer,
  developer.
- **balanced** (`base_resume_balanced.md`) — the default. Use when the
  JD matches keywords from multiple categories, the category is
  ambiguous, or nothing above clearly fits. Note this in your output
  under the "resume_used" field.

## Step 2 — Tailor
Your output must be a JSON object with exactly these fields:
{
  "resume_used": "swe" | "ai_ml" | "balanced" | "cyber" | "networking_cyber",
  "tailored_bullets": ["...", "..."],
  "cover_letter": "...",
  "ats_score": 85,
  "missing_keywords": ["...", "..."]
}

## Tailoring rules
- Reorder and rewrite resume bullets to front-load the most relevant
  experience for this specific JD.
- Mirror exact keywords from the JD requirements section — ATS systems
  do literal keyword matching.
- For internship JDs: lead with projects, coursework, and skills over
  work history. Emphasize learning velocity and ownership.
- For new grad JDs: treat graduation date and degree as strengths, not
  gaps. Mirror the JD's language around "growth", "mentorship", and
  "foundation".
- Cover letter: use data/resumes/base_cover_letter.md as the voice and
  structure reference, but open with a specific line about the
  company's product or mission, not a generic opener. For internships,
  reference a specific team or project named in the JD if one exists.
- Never fabricate experience. Only rephrase what exists in the selected
  base resume file.
- If the JD has a hard requirement the resume clearly cannot meet (e.g.
  "must have 5+ years" or a security clearance you don't hold), set
  ats_score below 40.

Read the selected base resume file before tailoring. Do not read every
base resume — only read a second one if the category is ambiguous and
you need to compare fit.
