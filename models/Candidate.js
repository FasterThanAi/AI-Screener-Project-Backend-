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