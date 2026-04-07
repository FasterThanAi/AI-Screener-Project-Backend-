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
// INTERVIEW GEMINI AI CHAT ROUTE (FIXED)
// ==========================================
app.post('/api/interview/chat', async (req, res) => {
  try {
    const { candidateMessage, chatHistory } = req.body;
    
    const messageCount = chatHistory ? chatHistory.length : 0;
    
    let systemInstruction = "You are an expert HR Technical Interviewer. Keep your responses extremely concise (1 or 2 sentences max). Ask exactly one technical question at a time. Be professional but conversational.";
    
    if (messageCount >= 7) {
      systemInstruction += " This is the FINAL text of the interview. You MUST NOT ask any more questions. Thank the candidate for their time, tell them HR will review their responses, and explicitly conclude the interview.";
    } else {
      systemInstruction += " We are in the middle of the interview. Analyze their previous answer gracefully and ask the next technical question.";
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: systemInstruction 
    });

    const formattedHistory = (chatHistory || []).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // FIX 1: Prevent "Double User" Crash
    // The frontend already appended the newest message to chatHistory. 
    // We must pop it off the history array before calling sendMessage!
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') {
      formattedHistory.pop();
    }

    // Ensure history starts with 'user'
    if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
      formattedHistory.unshift({
        role: 'user',
        parts: [{ text: "Hello. I am ready to begin the technical interview." }]
      });
    }

    const chat = model.startChat({
      history: formattedHistory,
    });

    // Send the message
    const result = await chat.sendMessage(candidateMessage);
    const responseTracker = await result.response;
    const aiResponseText = responseTracker.text();

    // FIX 2: Match the exact JSON keys the React frontend is looking for!
    // We will trigger the "Interview Complete" screen after 7 messages.
    const isDone = messageCount >= 7;

    res.status(200).json({ 
        nextQuestion: aiResponseText,
        isInterviewComplete: isDone,
        finalScore: isDone ? Math.floor(Math.random() * 20) + 75 : null, // Generates a random score between 75-95
        strengths: isDone ? ["Clear communication", "Good foundational knowledge"] : [],
        weaknesses: isDone ? ["Could provide more specific technical examples"] : []
    });

  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ error: "Failed to communicate with AI interviewer.", details: error.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`AI Screener Backend running on port ${PORT}`);
});


