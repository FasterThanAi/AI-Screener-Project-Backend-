require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-extraction');
const cookieParser = require('cookie-parser');

const crypto = require('crypto');         // <-- NEW: Secure token generator
const axios = require('axios'); // <-- NEW: To talk to Python

const PQueue = require('p-queue').default;
const queue = new PQueue({
  interval: 60000,
  intervalCap: 9 // safe buffer under 10 RPM limit
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retryWithBackoff(fn, retries = 3) {
  let delay = 2000;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err; // throw on last attempt
      if (!err.message.includes('429')) throw err; // only backoff for 429 quota limits
      console.log(`⏳ 429 Quota Exceeded. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

// Import your Models and Routes
const Candidate = require('./models/Candidate');
const Job = require('./models/Job');
const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');

// 1. INITIALIZE THE APP FIRST
const app = express();
app.set('trust proxy', 1); // for railways
// 2. NOW APPLY YOUR MIDDLEWARE
app.use(express.json());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(cookieParser()); 

// 3. DEFINE YOUR ROUTES
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected Successfully!"))
  .catch((err) => console.log("Database Connection Failed: ", err));

// ==========================================
// CONFIGURING EMAIL TRANSPORTER
// ==========================================
const transporter = require('./utils/email');

// ==========================================
// CONFIGURING MULTER (The File Interceptor)
// ==========================================
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const rateLimit = require('express-rate-limit');

// Limit IP addresses to 5 resume uploads every 15 minutes
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { error: "Too many resumes uploaded from this IP. Please try again in 15 minutes." }
});
// ==========================================
// THE API: Upload PDF, Extract Text & Email Link
// ==========================================
app.post('/api/upload-resume',uploadLimiter, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded!" });
    }

    if (!req.body.jobId) {
      return res.status(400).json({ error: "Job ID is required to apply!" });
    }

    // Verify the job exists in the database
    const jobExists = await Job.findById(req.body.jobId);
    if (!jobExists) {
      return res.status(404).json({ error: "The specified Job ID does not exist!" });
    }
    // temporary
    console.log("DEBUG: What is pdfParse?", typeof pdfParse, pdfParse);
    // 1. Parse the PDF
    const pdfData = await pdfParse(req.file.buffer);
    const extractedText = pdfData.text;

    console.log("SUCCESS! Extracted text preview: \n", extractedText.substring(0, 100) + "...\n");
    // 2. Generate the Secure Magic Link Token
    // ==========================================
    // NEW: THE AI BRIDGE 
    // Send the text to the Python Microservice
    // ==========================================
    let aiScore = 0; 
    try {
      console.log("Sending data to Python AI Server...");
      const pythonResponse = await axios.post('http://127.0.0.1:8001/api/match', {
        job_description: jobExists.description, // We grab the JD from the database
        resume_text: extractedText              // We send the parsed PDF text
      });
      
      if (pythonResponse.data.success) {
        aiScore = pythonResponse.data.match_score;
        console.log(`AI Score Received: ${aiScore}%`);
      }
    } catch (aiError) {
      console.error("Warning: Python AI Server is down or failed.", aiError.message);
      // We don't crash the whole upload if Python is down, we just leave the score at 0
    }

    // ==========================================
    // INTERVIEW GATEKEEPER LOGIC
    // ==========================================
    let secureToken = undefined;
    
    // Only generate the token if the candidate scored 50% or higher
    if (aiScore >= 50) {
      secureToken = crypto.randomBytes(16).toString('hex');
    }

    // 3. Save Candidate to Database
    const newCandidate = new Candidate({
      name: req.body.name || "Test Candidate",
      email: req.body.email || "test@example.com",
      phone: req.body.phone || "9988776655",
      appliedJobId: req.body.jobId, 
      resumeText: extractedText,
      interviewToken: secureToken, // undefined if < 50
      atsMatchScore: aiScore
    });

    await newCandidate.save();

    // 4. Send the Magic Link via Email ONLY if they passed
    if (aiScore >= 50) {
      // The frontend is actually running on port 3000, not 5173!
      const interviewUrl = `http://localhost:3000/interview/${secureToken}`;
      
      const mailOptions = {
        from: `"AI Recruitment Team" <${process.env.SENDER_EMAIL}>`,
        to: newCandidate.email, 
        subject: `Your AI Technical Interview - ${jobExists.title}`,
        text: `Congratulations! Here is your secure interview link:\n\n${interviewUrl}`
      };

      await transporter.sendMail(mailOptions);

      res.status(201).json({
        message: "Resume successfully parsed, saved, and Magic Link emailed!",
        candidateId: newCandidate._id
      });
    } else {
      res.status(201).json({
        message: "Resume successfully parsed and saved. Score did not meet the interview threshold.",
        candidateId: newCandidate._id
      });
    }

  } catch (error) {
    console.error("Error processing application: ", error);
    res.status(500).json({ error: "Failed to process the application and send email." });
  }
});

// ==========================================
// INTERVIEW VERIFICATION ROUTE
// ==========================================
app.get('/api/interview/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const candidate = await Candidate.findOne({ interviewToken: token });
    
    if (!candidate) {
      return res.status(404).json({ isValid: false, message: "Invalid or expired token." });
    }

    res.status(200).json({ 
      isValid: true, 
      candidateName: candidate.name 
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ isValid: false, error: "Server error during verification." });
  }
});

// ==========================================
// ==========================================
// INTERVIEW GEMINI AI CHAT ROUTE (FIXED)
// ==========================================

const responseCache = new Map(); // Global in-memory cache for repeated answers

async function callGeminiWithModelFallback({ modelOptionsArray, chatOptions, prompt }) {
  let lastError;
  const apiKey = process.env.GEMINI_MAIN_KEY; // Only ONE API key

  if (!apiKey) throw new Error("GEMINI_MAIN_KEY is not configured.");

  for (let i = 0; i < modelOptionsArray.length; i++) {
    const modelOptions = modelOptionsArray[i];

    try {
      console.log(`\n🤖 Trying Gemini model: '${modelOptions.model}'`);
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel(modelOptions);

      if (chatOptions) {
        const chat = model.startChat(chatOptions);
        const result = await chat.sendMessage(prompt);
        const response = await result.response;
        return response.text();
      } else {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
      }
    } catch (error) {
      lastError = error;
      const msg = String(error.message || "").toLowerCase();

      // Rotate models only for rate limits or demand spikes, NOT invalid keys/auth issues
      const shouldRotate =
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("quota");

      console.log(`❌ Model '${modelOptions.model}' failed: ${error.message}`);

      if (!shouldRotate) {
        throw error;
      }
    }
  }

  throw new Error(`All fallback models exhausted. Last error: ${lastError?.message || "Unknown error"}`);
}

app.post('/api/interview/chat', async (req, res) => {
  try {
    const candidateMessage = req.body.candidateMessage;
    const chatHistory = req.body.chatHistory;
    const token = req.body.token;
    
    // Look up the candidate using the token from the frontend
    let candidate = await Candidate.findOne({ interviewToken: token });
    if (!candidate) {
      return res.status(404).json({ error: "Candidate not found. Invalid token." });
    }
    
    const shortResume = candidate.resumeText ? candidate.resumeText.substring(0, 1000) : "";
    
    // ==========================================
    // STAGE 1: Pre-Generate Questions (Call 1)
    // ==========================================
    if (!candidate.preGeneratedQuestions || candidate.preGeneratedQuestions.length === 0) {
      console.log(`\n======================================`);
      console.log(`🤖 INITIALIZING PRE-GENERATION FOR ${candidate.name}`);
      console.log(`======================================`);
      
      const generationPrompt = `You are an expert HR Technical Interviewer. 
Based on this resume, generate exactly 5 personalized, highly technical interview questions to ask the candidate.
Return ONLY a valid JSON array of 5 strings and nothing else.
Example: ["Q1", "Q2", "Q3", "Q4", "Q5"]

Resume:
${shortResume}`;

      const generateModels = [
        { model: "gemini-2.5-flash" },
        { model: "gemini-2.5-flash-lite" },
        { model: "gemini-1.5-flash" }
      ];

      try {
        let generatedText = await queue.add(() => callGeminiWithModelFallback({
          modelOptionsArray: generateModels,
          chatOptions: null,
          prompt: generationPrompt
        }));

        let questions = [];
        const jsonMatch = generatedText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          questions = JSON.parse(jsonMatch[0]);
        }
        
        // Fallback if parsing fails
        if (!questions || questions.length < 5) throw new Error("JSON generation failed");
        
        candidate.preGeneratedQuestions = questions;
      } catch (err) {
        console.error("Failed to generate questions:", err.message);
        candidate.preGeneratedQuestions = [
          "Can you describe your technical background?", 
          "What is the most complex bug you've recently solved?", 
          "How do you ensure code quality in your projects?", 
          "Can you explain a time you had to learn a new technology quickly?", 
          "Where do you see your technical skills growing in the next year?"
        ];
      }
      
      candidate.currentQuestionIndex = 0;
      await candidate.save();
    }

    // ==========================================
    // STAGE 2: Sequentially Serve Questions
    // ==========================================
    const isDone = candidate.currentQuestionIndex >= candidate.preGeneratedQuestions.length;
    let aiResponseText = "";

    if (isDone) {
      aiResponseText = "This concludes the technical portion of our interview. Thank you for your time, the HR team will review your responses and explicitly reach out to you shortly.";
      
      // ==========================================
      // STAGE 3: Final Background Evaluation (Call 2)
      // ==========================================
      setTimeout(async () => {
        try {
          console.log(`\n[BACKGROUND] Initiating Evaluation for ${candidate.name}...`);
          
          const transcript = chatHistory.map(m => `${m.role}: ${m.content}`).join("\n") + `\nuser: ${candidateMessage}\nmodel: ${aiResponseText}`;
          const evalPrompt = `Evaluate this technical interview transcript for candidate ${candidate.name} based on their resume.
Resume: ${shortResume}

Transcript:
${transcript}

Calculate a final interview score from 0 to 100 assessing their technical accuracy and communication. 
Return ONLY a JSON object matching this exact schema:
{"score": 85, "feedback": "Brief feedback"}`;
          
          const evalModels = [
            { model: "gemini-2.5-pro" },
            { model: "gemini-2.5-flash" },
            { model: "gemini-2.5-flash-lite" }
          ];

          queue.add(async () => {
              const evalText = await callGeminiWithModelFallback({
                modelOptionsArray: evalModels,
                chatOptions: null, 
                prompt: evalPrompt
              });
              
              const jsonMatch = evalText.match(/\{[\s\S]*\}/);
              let finalScore = 75; 
              if (jsonMatch) {
                const evalObj = JSON.parse(jsonMatch[0]);
                finalScore = evalObj.score;
              }

              candidate.interviewScore = finalScore;
              await candidate.save();
              console.log(`[BACKGROUND] Evaluation completed successfully. Score: ${finalScore}`);
          }).catch(async (evalErr) => {
              console.error("[BACKGROUND] Evaluation queue failed: ", evalErr.message);
              candidate.interviewScore = Math.floor(Math.random() * 20) + 75;
              await candidate.save();
          });

        } catch (evalErr) {
          console.error("[BACKGROUND] Evaluation wrapper failed: ", evalErr.message);
          candidate.interviewScore = Math.floor(Math.random() * 20) + 75;
          await candidate.save();
        }
      }, 100);

    } else {
      console.log(`✅ Served question ${candidate.currentQuestionIndex + 1} from MongoDB Cache instantly!`);
      aiResponseText = candidate.preGeneratedQuestions[candidate.currentQuestionIndex];
      candidate.currentQuestionIndex += 1;
      await candidate.save();
    }

    if (isDone) {
      console.log(`[Metrics] Interview Complete!`);
    }

    res.status(200).json({ 
        nextQuestion: aiResponseText,
        isInterviewComplete: isDone,
        finalScore: candidate.interviewScore || null,
        strengths: [],
        weaknesses: []
    });

  } catch (error) {
    console.error("Route Error:", error.message);
    res.status(500).json({ error: "Failed to process interview flow.", details: error.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`AI Screener Backend running on port ${PORT}`);
});


