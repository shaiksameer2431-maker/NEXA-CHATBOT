import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";


async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper to get no verified info warning
  function getNoVerifiedInfoWarning() {
    return "I couldn't find reliable information for your question in our current knowledge base. If you'd like, you can create a Support Ticket and a college administrator will review your request personally.";
  }

  // Lazy initialize Gemini client
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient() {
    if (!aiClient) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        console.warn("GEMINI_API_KEY environment variable is not defined. Gemini AI endpoint is inactive.");
        return null;
      }
      aiClient = new GoogleGenAI({
        apiKey: key,
      });
    }
    return aiClient;
  }

  async function safeGenerateContent(models: any, params: any) {
    let retries = 5;
    while (retries > 0) {
      try {
        return await models.generateContent(params);
      } catch (err: any) {
        // Check if error is rate limit (code 429) or high demand (code 503)
        const isRetryableError = err.status === 429 || err.status === 503 || (err.message && (err.message.includes('429') || err.message.includes('503')));
        if (isRetryableError && retries > 1) {
          retries--;
          // Try to extract retry delay from error message
          let delay = 10000; // Increase default wait to 10s
          if (err.message) {
            const match = err.message.match(/Please retry in ([0-9.]+)s/);
            if (match && match[1]) {
              delay = Math.min(parseFloat(match[1]) * 1000 + 1000, 60000); // Add 1s buffer, cap at 60s
            }
          }
          console.warn(`[GEMINI] Retryable error hit (status: ${err.status}), retrying in ${delay}ms. Retries left: ${retries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
  }

  // Translation Cache for multilingual support to stay strictly within rate limits
  const translationCache = new Map<string, { question: string, answer: string, originalHash: string }>();

  function getRuleHash(question: string, answer: string): string {
    const q = question || "";
    const a = answer || "";
    return `${q.length}_${a.length}_${q.slice(0, 15)}_${a.slice(0, 15)}`;
  }

  // --- Website Knowledge Engine Helpers ---

  // Helper to initialize Supabase client (using env vars or custom parameters)
  function getSupabaseClient(customUrl?: string, customKey?: string) {
    const url = customUrl || process.env.SUPABASE_URL;
    const key = customKey || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      return null;
    }
    try {
      return createClient(url, key);
    } catch (e) {
      console.error("Failed to initialize Supabase client:", e);
      return null;
    }
  }

  // Extracts clean, readable text from HTML by removing scripts, styles, and tags
  function extractCleanText(html: string): string {
    // Strip script and style tags
    let cleaned = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    // Replace markup tags with spaces
    cleaned = cleaned.replace(/<[^>]+>/g, " ");
    // Unescape standard HTML entities
    cleaned = cleaned
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
    // Collapse sequences of whitespace
    return cleaned.replace(/\s+/g, " ").trim();
  }

  // BFS Crawler to fetch, parse, and discover internal pages of a website
  async function crawlWebsite(startUrl: string, domain: string, limit = 8) {
    const visited = new Set<string>();
    const queue: string[] = [startUrl];
    const results: { url: string; title: string; content: string }[] = [];

    // Ensure the domain has protocol prefix
    let domainOrigin = domain;
    if (!domainOrigin.startsWith("http://") && !domainOrigin.startsWith("https://")) {
      domainOrigin = `https://${domainOrigin}`;
    }

    while (queue.length > 0 && visited.size < limit) {
      const currentUrl = queue.shift()!;
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      console.log(`[CRAWLER] Fetching: ${currentUrl}`);
      try {
        const response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "NEXAKnowledgeCrawler/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9"
          },
          signal: AbortSignal.timeout(6000) // 6s timeout per page
        });

        if (!response.ok) {
          console.log(`[CRAWLER] Non-ok status ${response.status} for ${currentUrl}`);
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          console.log(`[CRAWLER] Skipping non-HTML content for ${currentUrl}`);
          continue;
        }

        const html = await response.text();

        // Extract <title>
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : "Untitled Page";

        // Clean text content
        const content = extractCleanText(html);

        if (content.length > 50) { // skip thin or empty pages
          results.push({
            url: currentUrl,
            title,
            content
          });
        }

        // Parse anchors to find links inside the same domain
        const hrefRegex = /href=["']([^"']+)["']/gi;
        let match;
        while ((match = hrefRegex.exec(html)) !== null) {
          let href = match[1].trim();
          href = href.split("#")[0].split("?")[0]; // remove hash and queries
          if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
            continue;
          }

          let absoluteUrl = "";
          if (href.startsWith("http://") || href.startsWith("https://")) {
            if (href.startsWith(domainOrigin)) {
              absoluteUrl = href;
            }
          } else if (href.startsWith("/")) {
            absoluteUrl = `${domainOrigin}${href}`;
          } else {
            // Relative URL resolution
            const base = currentUrl.endsWith("/") ? currentUrl : currentUrl + "/";
            try {
              absoluteUrl = new URL(href, base).toString();
            } catch {
              continue;
            }
          }

          if (absoluteUrl && absoluteUrl.startsWith(domainOrigin) && !visited.has(absoluteUrl) && !queue.includes(absoluteUrl)) {
            // Skip typical static assets
            const isAsset = /\.(jpg|jpeg|png|gif|svg|pdf|css|js|woff|woff2|ttf|json|xml|ico|zip|gz)$/i.test(absoluteUrl);
            if (!isAsset) {
              queue.push(absoluteUrl);
            }
          }
        }
      } catch (e) {
        console.warn(`[CRAWLER] Error fetching ${currentUrl}:`, e);
      }
    }

    return results;
  }


  // Dynamic Rule-translation Gemini API Endpoint
  app.post("/api/translate-rules", async (req, res) => {
    try {
      const { rules = [], language } = req.body;
      if (!language || language === 'en' || rules.length === 0) {
        return res.json({ translatedRules: [] });
      }

      // Filter active rules to translate
      const activeRules = rules.filter((r: any) => r.status === 'Active');
      if (activeRules.length === 0) {
        return res.json({ translatedRules: [] });
      }

      const translatedRules: any[] = [];
      const missingRules: any[] = [];

      for (const rule of activeRules) {
        const cacheKey = `${language}_${rule.id}`;
        const currentHash = getRuleHash(rule.question, rule.answer);
        const cached = translationCache.get(cacheKey);

        if (cached && cached.originalHash === currentHash) {
          translatedRules.push({
            id: rule.id,
            question: cached.question,
            answer: cached.answer
          });
        } else {
          missingRules.push(rule);
        }
      }

      // If everything is already cached, return immediately
      if (missingRules.length === 0) {
        return res.json({ translatedRules });
      }

      const client = getGeminiClient();
      if (!client) {
        // Fallback: If Gemini is not configured, just return the untranslated missing rules
        const merged = [
          ...translatedRules,
          ...missingRules.map((r: any) => ({ id: r.id, question: r.question, answer: r.answer }))
        ];
        return res.json({ translatedRules: merged, isFallback: true });
      }

      const langName = language === 'te' ? 'Telugu (తెలుగు)' : language === 'hi' ? 'Hindi (हिन्दी)' : 'English';

      const prompt = `You are a professional translator. Translate the following college Q&A rules into ${langName}.
You must preserve the original 'id' for each rule, but translate the 'question' and 'answer' into fluent, natural ${langName}. Keep any technical terms, branch names (like CSE, ECE), emails, phone numbers, and URLs as they are.

Rules to translate:
${JSON.stringify(missingRules.map((r: any) => ({ id: r.id, question: r.question, answer: r.answer })))}

You MUST return your response as a valid JSON object matching this schema exactly:
{
  "translatedRules": [
    {
      "id": "original_rule_id",
      "question": "translated question in ${langName}",
      "answer": "translated answer in ${langName}"
    }
  ]
}`;

      const response = await safeGenerateContent(client.models, {
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
        }
      });

      const text = response.text || "{}";
      const parsed = JSON.parse(text);
      const newTranslations = parsed.translatedRules || [];

      // Save new translations to cache
      for (const item of newTranslations) {
        const origRule = missingRules.find((r: any) => r.id === item.id);
        if (origRule) {
          const cacheKey = `${language}_${item.id}`;
          const currentHash = getRuleHash(origRule.question, origRule.answer);
          translationCache.set(cacheKey, {
            question: item.question,
            answer: item.answer,
            originalHash: currentHash
          });
          translatedRules.push(item);
        }
      }

      // For any missing rules that failed to get translated, make sure we have them
      for (const rule of missingRules) {
        if (!translatedRules.some((r: any) => r.id === rule.id)) {
          translatedRules.push({
            id: rule.id,
            question: rule.question,
            answer: rule.answer
          });
        }
      }

      res.json({ translatedRules });
    } catch (err: any) {
      console.warn("Translate rules error (falling back to original text):", err);
      // Fallback: Return original untranslated rules so that the app stays functional
      const fallbackRules = req.body.rules.map((r: any) => ({
        id: r.id,
        question: r.question,
        answer: r.answer
      }));
      res.json({ translatedRules: fallbackRules, isFallback: true, error: err.message });
    }
  });

  // Dynamic Message-translation Gemini API Endpoint
  app.post("/api/translate-messages", async (req, res) => {
    try {
      const { messages = [], targetLanguage } = req.body;
      if (!targetLanguage || targetLanguage === 'en' || messages.length === 0) {
        return res.json({ translatedMessages: [] });
      }

      const client = getGeminiClient();
      if (!client) {
        // Fallback: If Gemini is not configured, return original messages
        return res.json({ translatedMessages: messages.map((m: any) => ({ id: m.id, text: m.text })), isFallback: true });
      }

      const langName = targetLanguage === 'te' ? 'Telugu (తెలుగు)' : targetLanguage === 'hi' ? 'Hindi (हिन्दी)' : targetLanguage;

      const prompt = `You are a professional, expert translator. Translate the following user and bot chat messages into fluent, natural, and friendly ${langName}.
You must preserve the original 'id' for each message, and translate the 'text' of the message. Keep any technical terms, college names (like Narayana Engineering College, Narayana Student Portal, Nexa, CSE, B.Tech, Hall Ticket, CGPA, etc.), emails, phone numbers, and URLs exactly as they are. Keep emojis intact.

Messages to translate:
${JSON.stringify(messages.map((m: any) => ({ id: m.id, text: m.text })))}

You MUST return your response as a valid JSON object matching this schema exactly:
{
  "translatedMessages": [
    {
      "id": "message_id",
      "text": "translated message text in ${langName}"
    }
  ]
}`;

      const response = await safeGenerateContent(client.models, {
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
        }
      });

      const text = response.text || "{}";
      const parsed = JSON.parse(text);
      const translatedMessages = parsed.translatedMessages || [];

      res.json({ translatedMessages });
    } catch (err: any) {
      console.error("Translate messages error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Website Knowledge Engine endpoints ---

  // Endpoint to test connection and check if required tables exist in Supabase
  app.post("/api/website-knowledge/test-connection", async (req, res) => {
    const { supabaseUrl, supabaseKey } = req.body;
    const client = getSupabaseClient(supabaseUrl, supabaseKey);
    if (!client) {
      return res.status(400).json({ 
        success: false, 
        error: "Supabase URL and Anon Key are required. Provide them in settings or verify .env parameters." 
      });
    }

    try {
      const { error: rulesError } = await client.from("college_rules").select("id").limit(1);
      const { error: contentError } = await client.from("website_indexed_content").select("id").limit(1);

      const rulesTableExists = !rulesError || !rulesError.message.includes('does not exist');
      const contentTableExists = !contentError || !contentError.message.includes('does not exist');

      if (rulesTableExists && contentTableExists) {
        return res.json({ 
          success: true, 
          message: "Connection successful! Both tables (college_rules and website_indexed_content) are ready." 
        });
      }

      return res.json({
        success: false,
        error: "Connection established but required tables are missing in your Supabase database.",
        details: {
          rulesTable: rulesTableExists ? "Ready" : "Missing (college_rules)",
          contentTable: contentTableExists ? "Ready" : "Missing (website_indexed_content)"
        },
        sqlSetup: `
-- RUN THIS IN YOUR SUPABASE SQL EDITOR TO CREATE THE REQUIRED TABLES:

CREATE TABLE IF NOT EXISTS college_rules (
  id TEXT PRIMARY KEY,
  category TEXT,
  question TEXT NOT NULL,
  keywords TEXT,
  synonyms TEXT,
  answer TEXT NOT NULL,
  related_department TEXT,
  priority INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS website_indexed_content (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  domain TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  content TEXT NOT NULL,
  last_indexed TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_website_indexed_content_domain ON website_indexed_content(domain);
        `
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: "Connection failed: " + err.message });
    }
  });

  // Endpoint to sync existing rules from memory/Firestore into the Supabase rules database
  app.post("/api/website-knowledge/sync-rules", async (req, res) => {
    const { supabaseUrl, supabaseKey, rules = [] } = req.body;
    const client = getSupabaseClient(supabaseUrl, supabaseKey);
    if (!client) {
      return res.status(400).json({ error: "Supabase client not configured." });
    }

    try {
      if (rules.length === 0) {
        return res.json({ success: true, count: 0, message: "No rules to sync." });
      }

      const activeRules = rules.filter((r: any) => r.status === "Active");
      const mapped = activeRules.map((r: any) => ({
        id: r.id,
        category: r.category,
        question: r.question,
        keywords: r.keywords || "",
        synonyms: r.synonyms || "",
        answer: r.answer,
        related_department: r.relatedDepartment || "ADMIN",
        priority: Number(r.priority) || 1,
        status: r.status || "Active"
      }));

      const { error } = await client.from("college_rules").upsert(mapped, { onConflict: "id" });
      if (error) {
        throw error;
      }

      res.json({ success: true, count: mapped.length, message: `Successfully synchronized ${mapped.length} rules to Supabase!` });
    } catch (err: any) {
      console.error("Sync rules to Supabase error:", err);
      res.status(500).json({ error: "Sync failed: " + err.message });
    }
  });

  // Endpoint to crawl a website and store its text blocks in Supabase
  app.post("/api/website-knowledge/crawl", async (req, res) => {
    const { startUrl, domain, limit, supabaseUrl, supabaseKey } = req.body;
    if (!startUrl || !domain) {
      return res.status(400).json({ error: "startUrl and domain are required." });
    }

    const client = getSupabaseClient(supabaseUrl, supabaseKey);
    if (!client) {
      return res.status(400).json({ error: "Supabase credentials are not configured. Cannot save crawled results." });
    }

    console.log(`[WEBSITE KNOWLEDGE] Initiated crawl on ${startUrl} for domain ${domain} (limit: ${limit || 8})`);

    try {
      const crawlResults = await crawlWebsite(startUrl, domain, limit || 8);
      if (crawlResults.length === 0) {
        return res.json({ success: false, error: "No content could be extracted from the website pages. Please check the starting URL and ensure it has public text content." });
      }

      const upsertData = crawlResults.map(r => ({
        domain: domain,
        url: r.url,
        title: r.title,
        content: r.content,
        last_indexed: new Date().toISOString()
      }));

      const { error } = await client.from("website_indexed_content").upsert(upsertData, { onConflict: "url" });
      if (error) {
        throw error;
      }

      res.json({
        success: true,
        pagesCount: crawlResults.length,
        pages: crawlResults.map(p => ({ url: p.url, title: p.title, length: p.content.length })),
        message: `Successfully crawled and indexed ${crawlResults.length} pages into Supabase!`
      });
    } catch (err: any) {
      console.error("Crawl error:", err);
      res.status(500).json({ error: "Crawl and indexation failed: " + err.message });
    }
  });

  // Chat/Translation Gemini API Endpoint
  app.post("/api/chat", async (req, res) => {
    const { message, language, rules = [], chatHistory = [], supabaseUrl, supabaseKey, domain } = req.body;
    const langName = language === 'te' ? 'Telugu (తెలుగు)' : language === 'hi' ? 'Hindi (हिन्दी)' : 'English';
    const activeRules = rules.filter((r: any) => r.status === 'Active');
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // 1. Fetch website knowledge if domain provided
    let websiteContext = "";
    if (domain) {
      try {
        const supabase = getSupabaseClient(supabaseUrl, supabaseKey);
        if (!supabase) throw new Error("Supabase not configured");
        const { data: knowledge, error } = await supabase
          .from("website_indexed_content")
          .select("title, content")
          .eq("domain", domain)
          .textSearch("content", message)
          .limit(3);

        if (!error && knowledge && knowledge.length > 0) {
          websiteContext = `WEBSITE KNOWLEDGE BASE:
${knowledge.map(k => `Title: ${k.title}\nContent: ${k.content}`).join("\n\n")}`;
          console.log(`[RAG] Retrieved ${knowledge.length} chunks for ${message}`);
        }
      } catch (err) {
        console.error("[RAG] Supabase search error:", err);
      }
    }

    const prompt = `
${websiteContext}

You are an AI assistant for ${domain || "our website"}.
Use the website knowledge provided above if relevant to answer the user's question. If the information is not in the knowledge base, use your own knowledge.
${websiteContext ? "Always prioritize the provided website knowledge." : ""}

User Message: ${message}
Current Language: ${langName}
`;

    // Helper to evaluate text matches on a list of rules
    const findBestRuleMatch = (rulesList: any[]) => {
      const query = message.toLowerCase().trim();
      let bestMatch: any = null;
      let highestScore = 0;

      for (const rule of rulesList) {
        let score = 0;
        const qText = (rule.question || "").toLowerCase();
        const kwList = (rule.keywords || "").toLowerCase().split(',').map((s: string) => s.trim()).filter(Boolean);
        const synList = (rule.synonyms || "").toLowerCase().split(',').map((s: string) => s.trim()).filter(Boolean);

        if (query === qText) {
          score += 100;
        } else if (qText.includes(query) || query.includes(qText)) {
          score += 50;
        }

        for (const kw of kwList) {
          if (query.includes(kw)) {
            score += kw.includes(' ') ? 30 : 15;
          }
        }

        for (const syn of synList) {
          if (query.includes(syn)) {
            score += syn.includes(' ') ? 20 : 10;
          }
        }

        if (score > highestScore) {
          highestScore = score;
          bestMatch = rule;
        }
      }

      return highestScore > 0 ? bestMatch : null;
    };

    try {
      const sClient = getSupabaseClient(supabaseUrl, supabaseKey);
      let answerFound = false;
      let answerText = "";
      let answerSource = "";

      // 1. FIRST SEARCH: Supabase Knowledge Base (college_rules table)
      if (sClient) {
        console.log("[CHAT-SUPABASE] Searching Supabase rules knowledge base first...");
        try {
          const { data: sRules, error: sRulesError } = await sClient
            .from("college_rules")
            .select("*")
            .eq("status", "Active");

          if (!sRulesError && sRules && sRules.length > 0) {
            const bestMatch = findBestRuleMatch(sRules);
            if (bestMatch) {
              answerFound = true;
              answerText = bestMatch.answer;
              answerSource = "Supabase Knowledge Base (Rules)";
            }
          } else if (sRulesError) {
            console.warn("[CHAT-SUPABASE] Supabase college_rules query failed:", sRulesError.message);
          }
        } catch (sError) {
          console.warn("[CHAT-SUPABASE] Error accessing college_rules:", sError);
        }
      }

      // 2. SECOND SEARCH: Indexed Website Content (website_indexed_content table)
      if (!answerFound && sClient && domain) {
        console.log(`[CHAT-SUPABASE] No rules match. Searching website crawled pages for domain: ${domain}...`);
        try {
          const { data: pages, error: pagesError } = await sClient
            .from("website_indexed_content")
            .select("url, title, content")
            .eq("domain", domain);

          if (!pagesError && pages && pages.length > 0) {
            // Find pages with matching keywords
            const queryWords = message.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            const scoredPages = pages.map(p => {
              let score = 0;
              const text = `${p.title} ${p.content}`.toLowerCase();
              for (const word of queryWords) {
                // Count occurrences
                const occurrences = (text.match(new RegExp(word, 'g')) || []).length;
                score += occurrences;
              }
              return { ...p, score };
            }).filter(p => p.score > 0 || queryWords.length === 0);

            // Sort and take top matching pages
            scoredPages.sort((a, b) => b.score - a.score);
            const relevantPages = scoredPages.slice(0, 4);

            if (relevantPages.length > 0) {
              const crawledPagesContext = relevantPages
                .map(p => `Page URL: ${p.url}\nPage Title: ${p.title}\nPage Content:\n${p.content}`)
                .join("\n\n---\n\n");

              // Ask Gemini to generate an answer strictly from this crawled website context
              const geminiClient = getGeminiClient();
              if (geminiClient) {
                const systemPrompt = `You are "Narayana NEXA", the official digital counselor assistant for Narayana Engineering College.
Your absolute goal is to answer the user's question.

CRITICAL INSTRUCTIONS:
1. You MUST synthesize and formulate your answer STICTLY and ONLY from the official website crawled content provided below. Do NOT make up any details or use external knowledge.
2. If the provided crawled pages do not contain verified information that answers the user's question, you MUST reply with exactly: "${getNoVerifiedInfoWarning()}"
3. Do NOT invent, assume, or hallucinate. Keep answers factual and precise.
4. You MUST include a source reference URL of the originating page at the end of your answer in the format: "Source: <URL>". If the answer is synthesized from multiple pages, include the primary source or list them clearly.
5. You MUST generate the final response naturally, professionally, and fluently in ${langName}. If Telugu, use Telugu script. If Hindi, use Devanagari script.

OFFICIAL CRAWLED CONTENT:
${crawledPagesContext}
`;

                const formattedContents = [
                  { role: "user", parts: [{ text: "Hello, assist me based on your system instructions." }] },
                  { role: "model", parts: [{ text: `Understood! I will answer your questions strictly from the official crawled website content, citing the exact source URL, in ${langName}. If the information is not present, I will respond with the verified warning.` }] },
                  { role: "user", parts: [{ text: message }] }
                ];

                const response = await safeGenerateContent(geminiClient.models, {
                  model: "gemini-3.5-flash",
                  contents: formattedContents,
                  config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.1, // Strict factual synthesis
                  }
                });

                const synthesizedReply = response.text || "";
                const warning = getNoVerifiedInfoWarning();
                
                if (synthesizedReply.includes(warning)) {
                  return res.json({
                    text: synthesizedReply,
                    isNoVerifiedWarning: true,
                    source: "Website Crawled Content (No Match)"
                  });
                }

                if (synthesizedReply.trim().length > 0) {
                  answerFound = true;
                  answerText = synthesizedReply;
                  answerSource = "Website Crawled Content";
                }
              } else {
                console.warn("[CHAT-SUPABASE] Gemini client is not configured. Cannot synthesize answer from crawled content.");
              }
            }
          } else if (pagesError) {
            console.warn("[CHAT-SUPABASE] website_indexed_content query failed:", pagesError.message);
          }
        } catch (pError) {
          console.warn("[CHAT-SUPABASE] Error accessing website_indexed_content:", pError);
        }
      }

      // 3. THIRD SEARCH (LOCAL DATABASE RULES FALLBACK): Search local database rules
      if (!answerFound && rules.length > 0) {
        console.log("[CHAT] Searching local rules database fallback...");
        const bestLocalMatch = findBestRuleMatch(activeRules);
        if (bestLocalMatch) {
          answerFound = true;
          answerText = bestLocalMatch.answer;
          answerSource = "Local Knowledge Base (Fallback)";
        }
      }

      // 4. FOURTH SEARCH (CONVERSATIONAL GEMINI SYNTHESIS - LOCAL RULES ONLY):
      // If we didn't find any answer in either rules database or crawled website, we MUST return the verified warning!
      if (!answerFound) {
        const finalWarning = getNoVerifiedInfoWarning();
        return res.json({
          text: finalWarning,
          isNoVerifiedWarning: true,
          source: "None"
        });
      }

      // Return the successfully sourced answer!
      return res.json({
        text: answerText,
        source: answerSource
      });

    } catch (err: any) {
      console.warn("Main chat handler error (falling back to local matching):", err);
      const query = message.toLowerCase().trim();
      const bestLocalMatch = findBestRuleMatch(activeRules);
      if (bestLocalMatch) {
        return res.json({ text: bestLocalMatch.answer, source: "Local Matcher Fallback" });
      } else {
        return res.json({ text: getNoVerifiedInfoWarning(), isNoVerifiedWarning: true });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
