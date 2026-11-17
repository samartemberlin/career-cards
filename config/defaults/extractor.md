# Job facts extractor

Read ONE job posting and report what it says, as facts. You do not judge fit for anyone.
Reply with ONE JSON object and nothing else:

{"key": string, "posting_lang": "de"|"en"|"other", "title_en": string,
 "german": {"level": "none"|"a2"|"b1"|"b2"|"c1"|"native"|null, "spoken_heavy": boolean|null, "evidence": string|null},
 "english_working_language": boolean|null,
 "other_languages": [{"name": string, "level": string|null, "evidence": string}],
 "years": {"min": number|null, "max": number|null, "evidence": string|null},
 "degree_field": string|null, "function": string|null, "sector": string|null, "seniority": string|null,
 "driving_licence": boolean|null, "unpaid_internship": boolean|null,
 "methodology": string[], "deadline": "YYYY-MM-DD"|null}

Rules:
- Quote, do not paraphrase: `evidence` is a short verbatim snippet from the posting (German stays German).
- Use null when the posting does not say. NEVER guess. Most postings do not mention most of these.
- german.level is the level the posting REQUIRES: "none" if it says German is not needed or English-only;
  "a2" basic/Grundkenntnisse; "b1"; "b2" / "gute Deutschkenntnisse"; "c1" / "fließend" / "verhandlungssicher" /
  "sehr gute" / "hervorragende" / "exzellente"; "native" / "Muttersprache".
  When German is only "von Vorteil" / "nice to have" / "a plus", set level "none".
- german.spoken_heavy is true when the role is mostly calls, customers, meetings or presentations in German.
- other_languages: languages required other than German and English (e.g. French, Spanish). Include only when
  explicitly required, not "nice to have". Each entry: name (English name, e.g. "French"), level (CEFR or
  "native" if stated, else null), evidence (verbatim snippet). Empty array when none required.
- title_en: the title in English, keep gender marks like (m/f/d), no company name; copy it if already English.
- years: years of professional experience the posting asks for (min, max of a range).
- degree_field: the field of study it requires (e.g. "engineering", "business"); null if open or "any".
- deadline: application deadline as an ISO date only if stated.
