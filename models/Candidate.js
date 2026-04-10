const mongoose = require('mongoose');

const CandidateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  
  // This links the candidate to the exact Job they applied for
  appliedJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  
  // The raw text ripped from the PDF
  resumeText: { type: String, required: true },
  interviewToken: { type: String },
  // The AI Scores (Will be filled in later)
  atsMatchScore: { type: Number, default: null }, // From your Python Model
  interviewScore: { type: Number, default: null }, // From Gemini API
  evaluationStatus: { type: String, enum: ['pending', 'complete'], default: null }, // Tracks async eval state

  // Rich evaluation report (populated by final Gemini call)
  questionFeedback: [{
    question: String,
    candidateAnswer: String,
    feedback: String
  }],
  overallSummary:      { type: String, default: null },
  strengths:           { type: [String], default: [] },
  weaknesses:          { type: [String], default: [] },
  finalRecommendation: { type: String, default: null },
  
  // 2-Call Architecture: Pre-generation columns
  preGeneratedQuestions: { type: [String], default: [] },
  currentQuestionIndex: { type: Number, default: 0 },
  
  // The entire conversation history saved as an array of objects
  interviewTranscript: [
    {
      question: String,
      candidateAnswer: String,
      aiRating: Number,
      aiFeedback: String
    }
  ],
  
  status: { 
    type: String, 
    enum: ['Applied', 'Shortlisted', 'Rejected'], 
    default: 'Applied' 
  },
  
  appliedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Candidate', CandidateSchema);