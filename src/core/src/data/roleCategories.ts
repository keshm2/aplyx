/** Checkbox categories for the Roles submenu (Settings' Company targets
 *  section). Checking a category writes its whole keyword bundle into
 *  targets.json's role_keywords array — evaluate_job_fit.py matches a
 *  posting's title/JD against that flat array, so these bundles are the
 *  single source of truth for what "checking Software Engineering"
 *  actually means at fit-gate time. */
export interface RoleCategory {
  id: string;
  label: string;
  keywords: string[];
}

export const ROLE_CATEGORIES: RoleCategory[] = [
  {
    id: "software_engineering",
    label: "Software Engineering",
    keywords: [
      "software engineer",
      "software engineering",
      "swe",
      "software developer",
      "backend engineer",
      "full stack engineer",
      "developer",
    ],
  },
  {
    id: "frontend_web",
    label: "Frontend / Web Engineering",
    keywords: [
      "frontend engineer",
      "front end engineer",
      "front-end engineer",
      "web developer",
      "ui engineer",
      "react developer",
    ],
  },
  {
    id: "mobile",
    label: "Mobile Engineering (iOS/Android)",
    keywords: ["mobile engineer", "ios engineer", "android engineer", "mobile developer", "app developer"],
  },
  {
    id: "ai_ml",
    label: "AI / Machine Learning",
    keywords: [
      "machine learning",
      "ml engineer",
      "ai engineer",
      "AI/ML engineer",
      "applied ai",
      "applied scientist",
      "llm",
      "nlp engineer",
    ],
  },
  {
    id: "data_engineering",
    label: "Data Engineering",
    keywords: ["data engineer", "data engineering", "etl engineer", "analytics engineer", "big data engineer"],
  },
  {
    id: "data_science",
    label: "Data Science / Analytics",
    keywords: ["data scientist", "data science", "data analyst", "business analyst", "bi analyst"],
  },
  {
    id: "networking",
    label: "Networking",
    keywords: ["network engineer", "network administrator", "network operations", "noc"],
  },
  {
    id: "cybersecurity",
    label: "Cybersecurity",
    keywords: [
      "security engineer",
      "cybersecurity",
      "information security",
      "soc analyst",
      "penetration tester",
      "appsec",
      "security analyst",
    ],
  },
  {
    id: "cloud_devops",
    label: "Cloud / DevOps / SRE",
    keywords: [
      "cloud engineer",
      "devops engineer",
      "site reliability engineer",
      "infrastructure engineer",
      "platform engineer",
      "sre",
    ],
  },
  {
    id: "qa_test",
    label: "QA / Test Engineering",
    keywords: ["qa engineer", "test engineer", "sdet", "quality assurance"],
  },
  {
    id: "product_program",
    label: "Product / Program Management",
    keywords: ["product manager", "program manager", "technical program manager", "apm"],
  },
  {
    id: "hardware_embedded",
    label: "Hardware / Embedded / Firmware",
    keywords: ["hardware engineer", "embedded engineer", "firmware engineer", "electrical engineer"],
  },
];
