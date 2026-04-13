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

    // ==========================================
    // RESET INTERVIEW SESSION STATE
    // Ensures every page load starts with a clean slate.
    // Prevents old Q&A data from corrupting a new session.
    // ==========================================
    await Candidate.findByIdAndUpdate(candidate._id, {
      $set: {
        preGeneratedQuestions: [],
        currentQuestionIndex:  0,
        interviewTranscript:   [],
        interviewScore:        null,
        evaluationStatus:      null,
        questionFeedback:      [],
        overallSummary:        null,
        strengths:             [],
        weaknesses:            [],
        finalRecommendation:   null,
        proctoringEvents:      []
      }
    });
    console.log(`[DB RESET] Session reset for candidate: ${candidate.name} (${candidate._id})`);

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

app.post('/api/interview/proctoring/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const candidate = await Candidate.findOne({ interviewToken: token }).select('_id name');

    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found. Invalid token.' });
    }

    const rawEvents = Array.isArray(req.body.events) ? req.body.events : [req.body];
    const events = rawEvents
      .map(normalizeProctoringEvent)
      .filter(Boolean)
      .slice(0, 25);

    if (events.length === 0) {
      return res.status(400).json({ error: 'At least one valid proctoring event is required.' });
    }

    await Candidate.findByIdAndUpdate(candidate._id, {
      $push: {
        proctoringEvents: {
          $each: events,
          $slice: -200
        }
      }
    });

    console.log(`[DB WRITE] Saved ${events.length} proctoring event(s) for ${candidate.name}`);

    res.status(201).json({
      success: true,
      recorded: events.length
    });
  } catch (error) {
    console.error('Proctoring ingestion error:', error.message);
    res.status(500).json({ error: 'Failed to record proctoring events.' });
  }
});

const responseCache = new Map(); // Global in-memory cache for repeated answers

const PROCTORING_EVENT_SEVERITY = {
  TAB_SWITCH: 'critical',
  WINDOW_BLUR: 'warning',
  MULTIPLE_FACES: 'critical',
  NO_FACE: 'critical',
  LOOKING_AWAY: 'warning',
  TOO_FAR: 'warning',
  TOO_CLOSE: 'info',
  WINDOW_FOCUS: 'info',
  ANALYSIS_ERROR: 'warning'
};

function normalizeProctoringEvent(rawEvent = {}) {
  const eventType = String(rawEvent.eventType || rawEvent.event || '').trim().toUpperCase();

  if (!eventType) {
    return null;
  }

  const parsedTimestamp =
    typeof rawEvent.timestamp === 'number'
      ? new Date(rawEvent.timestamp)
      : rawEvent.timestamp
        ? new Date(rawEvent.timestamp)
        : new Date();

  return {
    eventType,
    severity: PROCTORING_EVENT_SEVERITY[eventType] || rawEvent.severity || 'info',
    message: rawEvent.message || null,
    timestamp: Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp,
    details:
      rawEvent.details && typeof rawEvent.details === 'object' && !Array.isArray(rawEvent.details)
        ? rawEvent.details
        : rawEvent.metadata && typeof rawEvent.metadata === 'object' && !Array.isArray(rawEvent.metadata)
          ? rawEvent.metadata
          : {}
  };
}

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
    // STAGE 0: Save Transcript to Database
    // ==========================================
    if (candidateMessage && candidateMessage.trim() !== "") {
      let previousQuestion = "";
      // If we haven't generated yet, they just answered the intro question
      if (!candidate.preGeneratedQuestions || candidate.preGeneratedQuestions.length === 0) {
        previousQuestion = "Can you briefly introduce your background?";
      } else {
        // They are answering the question we previously served
        if (candidate.currentQuestionIndex > 0) {
          previousQuestion = candidate.preGeneratedQuestions[candidate.currentQuestionIndex - 1];
        } else {
          previousQuestion = candidate.preGeneratedQuestions[0];
        }
      }

      // Check for duplication (best-effort: uses in-memory snapshot fetched at request start)
      const isDuplicate = candidate.interviewTranscript.length > 0 &&
        candidate.interviewTranscript[candidate.interviewTranscript.length - 1].candidateAnswer === candidateMessage;

      if (!isDuplicate) {
        const transcriptEntry = {
          question: previousQuestion,
          candidateAnswer: candidateMessage,
          aiRating: null,
          aiFeedback: null
        };
        // ATOMIC $push — safe against concurrent saves overwriting the array
        await Candidate.findByIdAndUpdate(
          candidate._id,
          { $push: { interviewTranscript: transcriptEntry } },
          { new: false }
        );
        // Keep in-memory copy in sync so duplicate check works within same request
        candidate.interviewTranscript.push(transcriptEntry);
        console.log(`[DB WRITE] Transcript entry saved for ${candidate.name}: "${candidateMessage.substring(0, 60)}..."`);
      } else {
        console.log(`[DB SKIP] Duplicate answer detected for ${candidate.name} — skipping transcript save.`);
      }
    }
    
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
        
        candidate.preGeneratedQuestions = questions; // keep in-memory for STAGE 2
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

      candidate.currentQuestionIndex = 0; // keep in-memory for STAGE 2

      // ATOMIC $set — avoids overwriting transcript that was just $push'd above
      await Candidate.findByIdAndUpdate(candidate._id, {
        $set: {
          preGeneratedQuestions: candidate.preGeneratedQuestions,
          currentQuestionIndex: 0
        }
      });
      console.log(`[DB WRITE] ${candidate.preGeneratedQuestions.length} questions saved for ${candidate.name}, index reset to 0`);
    }

    // ==========================================
    // STAGE 2: Sequentially Serve Questions
    // ==========================================
    const isDone = candidate.currentQuestionIndex >= candidate.preGeneratedQuestions.length;
    let aiResponseText = "";

    if (isDone) {
      aiResponseText = "This concludes the technical portion of our interview. Thank you for your time, the HR team will review your responses and explicitly reach out to you shortly.";
      
      // Mark evaluation as pending BEFORE firing background task (atomic — does not touch transcript)
      await Candidate.findByIdAndUpdate(candidate._id, {
        $set: { evaluationStatus: 'pending' }
      });
      console.log(`[DB WRITE] evaluationStatus set to 'pending' for ${candidate.name}`);

      // ==========================================
      // STAGE 3: Final Background Evaluation (Call 2)
      // ==========================================
      setTimeout(async () => {
        try {
          console.log(`\n[BACKGROUND] Initiating Evaluation for ${candidate.name}...`);
          
          // Re-fetch candidate to ensure we have the absolute final transcript array saved
          const finalCandidateData = await Candidate.findById(candidate._id);
          const transcriptText = finalCandidateData.interviewTranscript.map((entry, idx) => 
            `[Q${idx + 1}] Interviewer: ${entry.question}\n[A${idx + 1}] Candidate: ${entry.candidateAnswer}`
          ).join("\n\n");

          const evalPrompt = `You are an expert technical interviewer. Evaluate the following interview transcript for candidate: ${finalCandidateData.name}.

Resume Summary:
${shortResume}

Full Interview Transcript:
${transcriptText}

Your task is to provide a comprehensive evaluation. Return ONLY a valid JSON object with EXACTLY this schema and no other text:
{
  "score": 85,
  "questionFeedback": [
    {
      "question": "Exact question text",
      "candidateAnswer": "Candidate's answer text",
      "feedback": "Specific, constructive feedback for this answer in 2-3 sentences"
    }
  ],
  "overallSummary": "A 3-4 sentence paragraph summarizing the candidate's overall performance, technical depth, and communication style.",
  "strengths": ["Specific strength 1", "Specific strength 2", "Specific strength 3"],
  "weaknesses": ["Specific area for improvement 1", "Specific area for improvement 2"],
  "finalRecommendation": "A concise recruiter-style hiring recommendation of 2-3 sentences."
}`;

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
              
              // Safe fallback defaults
              let finalScore = 70;
              let finalQuestionFeedback = [];
              let finalOverallSummary = "The interview has been evaluated.";
              let finalStrengths = [];
              let finalWeaknesses = [];
              let finalRecommendation = "Please review the interview transcript for further details.";

              if (jsonMatch) {
                try {
                  const evalObj = JSON.parse(jsonMatch[0]);
                  finalScore              = evalObj.score              ?? finalScore;
                  finalQuestionFeedback  = evalObj.questionFeedback   ?? finalQuestionFeedback;
                  finalOverallSummary    = evalObj.overallSummary     ?? finalOverallSummary;
                  finalStrengths         = evalObj.strengths          ?? finalStrengths;
                  finalWeaknesses        = evalObj.weaknesses         ?? finalWeaknesses;
                  finalRecommendation    = evalObj.finalRecommendation ?? finalRecommendation;
                } catch (parseErr) {
                  console.error("[BACKGROUND] JSON parse failed, using fallback values.", parseErr.message);
                }
              }

              // Persist all fields atomically
              await Candidate.findByIdAndUpdate(candidate._id, {
                interviewScore:      finalScore,
                questionFeedback:    finalQuestionFeedback,
                overallSummary:      finalOverallSummary,
                strengths:           finalStrengths,
                weaknesses:          finalWeaknesses,
                finalRecommendation: finalRecommendation,
                evaluationStatus:    'complete'
              });
              console.log(`[BACKGROUND] ✅ Full evaluation complete. Score: ${finalScore}`);
          }).catch(async (evalErr) => {
              console.error("[BACKGROUND] Evaluation queue failed: ", evalErr.message);
              await Candidate.findByIdAndUpdate(candidate._id, {
                interviewScore:      70,
                overallSummary:      "Evaluation could not be completed at this time.",
                finalRecommendation: "Please review the transcript manually.",
                evaluationStatus:    'complete'
              });
          });

        } catch (evalErr) {
          console.error("[BACKGROUND] Evaluation wrapper failed: ", evalErr.message);
          // BUG FIX: evaluationFeedback no longer exists — use overallSummary
          await Candidate.findByIdAndUpdate(candidate._id, {
            $set: {
              interviewScore:      70,
              overallSummary:      "Evaluation could not be completed at this time.",
              finalRecommendation: "Please review the transcript manually.",
              evaluationStatus:    'complete'
            }
          });
          console.log(`[DB WRITE] Fallback evaluation saved for ${candidate.name} (outer catch).`);
        }
      }, 100);

    } else {
      aiResponseText = candidate.preGeneratedQuestions[candidate.currentQuestionIndex];
      const nextIndex = candidate.currentQuestionIndex + 1;
      // ATOMIC $inc — prevents double-increment if two requests race
      await Candidate.findByIdAndUpdate(candidate._id, {
        $inc: { currentQuestionIndex: 1 }
      });
      console.log(`[DB WRITE] Question index incremented to ${nextIndex} for ${candidate.name} — served Q${nextIndex}`);
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
// INTERVIEW SCORE POLLING ENDPOINT
// ==========================================
app.get('/api/interview/score/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const candidate = await Candidate.findOne({ interviewToken: token });

    if (!candidate) {
      return res.status(404).json({ error: "Candidate not found." });
    }

    if (candidate.evaluationStatus === 'complete') {
      return res.status(200).json({
        status:              'complete',
        score:               candidate.interviewScore,
        feedback:            candidate.overallSummary || "Interview evaluated successfully.", // backward compat key
        questionFeedback:    candidate.questionFeedback    || [],
        overallSummary:      candidate.overallSummary      || "Interview evaluated successfully.",
        strengths:           candidate.strengths           || [],
        weaknesses:          candidate.weaknesses          || [],
        finalRecommendation: candidate.finalRecommendation || ""
      });
    }

    // Still running (pending or not started)
    return res.status(200).json({ status: 'pending' });

  } catch (error) {
    console.error("Score poll error:", error.message);
    res.status(500).json({ error: "Failed to fetch score." });
  }
});

// ==========================================
// START SERVER
// ===========================================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`AI Screener Backend running on port ${PORT}`);
});
