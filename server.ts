import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

dotenv.config();

const PORT = 3000;

async function startServer() {
  const app = express();

  // Add global diagnostic logging
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // Ensure uploads directory exists
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
  }

  // Setup multer for handling uploads
  const upload = multer({ 
    dest: "uploads/",
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
  });

  // Basic Body Parsers
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  const apiKey = process.env.GEMINI_API_KEY || "";
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  // --- API Routes ---
  // Define these BEFORE any other middleware to ensure they take precedence

  app.get("/api/health", (req, res) => {
    console.log("Health check hit");
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      apiKeyPresent: !!apiKey
    });
  });

  app.post("/api/subtitles/generate", (req, res, next) => {
    console.log(`[${new Date().toISOString()}] Incoming request: ${req.method} ${req.url}`);
    next();
  }, upload.single("media"), async (req, res) => {
    const file = req.file;
    const { targetLanguage, detectGender } = req.body;

    if (!file) {
      console.error("No file in request");
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`Processing file: ${file.originalname} (${file.size} bytes) for ${targetLanguage}, detectGender=${detectGender}`);

    try {
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set");
      }

      const fileBuffer = fs.readFileSync(file.path);
      const base64Data = fileBuffer.toString("base64");

      const modelName = "gemini-2.5-flash"; 

      console.log(`Calling Gemini API with model: ${modelName}`);
      
      let genderInstruction = "";
      if (detectGender === "true") {
        genderInstruction = `- Detect speaker character and strictly prefix every single subtitle text segment with one of these exact tags based on the speaker's voice:\n          [Female], [Male], [Old], [Girl], [Boy], [Extra], [Think_Female], [Think_Male], [Narrator].`;
      }

      const response = await ai.models.generateContentStream({
        model: modelName,
        config: {
          systemInstruction: `Professional subtitle generator. 
          - Output ONLY valid SRT content correctly numbered and with precise timestamps.
          - NEVER include markdown code blocks (\`\`\`).
          - NEVER include notes, introductions, or additional text.
          - Ensure every word of audio is translated using a cinematic/movie subtitle style (បកប្រែបែបភាពយន្ដ/កុន) that is natural, dramatic, and emotionally resonant.
          - The subtitles MUST be strictly and exclusively in ${targetLanguage}. DO NOT include the original spoken language, and do NOT create bilingual (dual-language) subtitles.
          - For example, if the target language is Khmer (ខ្មែរ), the subtitle lines must contain ONLY Khmer characters and translation, with absolutely no English or source language text.
          ${genderInstruction}`,
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: file.mimetype,
                  data: base64Data,
                },
              },
              {
                text: `TRANSLATION AND SUBTITLING TASK:
                1. Translate the spoken audio directly into ${targetLanguage} using movie subtitle style (បកប្រែបែបភាពយន្ដ/កុន) and segment it into standard SRT format.
                2. Do NOT output bilingual subtitles. Only output the target language (${targetLanguage}) translation.
                3. Completely discard the original spoken language text. Output ONLY the ${targetLanguage} translation.
                4. Ensure timestamps are perfectly aligned with the audio.
                5. Do not summarize. Output the full cinematic subtitle text.
                
                Output ONLY the raw SRT text containing strictly ${targetLanguage} translation.`,
              },
            ],
          },
        ],
      });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");

      let hasStarted = false;
      for await (const chunk of response) {
        const text = chunk.text;
        if (text) {
          let cleanText = text;
          if (!hasStarted && cleanText.includes("```")) {
             cleanText = cleanText.replace(/```[a-z]*\n/i, "");
             hasStarted = true;
          }
          cleanText = cleanText.replace(/```/g, "");
          res.write(cleanText);
        }
      }

      res.end();

      // Clean up temp file
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting temp file:", err);
      });

    } catch (error: any) {
      console.error("API Processing Error:", error);
      if (file && fs.existsSync(file.path)) {
        fs.unlink(file.path, () => {});
      }
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Failed to generate subtitles" });
      } else {
        res.end();
      }
    }
  });

  // Error handler for multer/other errors
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Global Error Handler:", err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    res.status(500).json({ error: "Internal Server Error" });
  });

  // API 404 fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  // --- Vite / Static Middleware ---

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
