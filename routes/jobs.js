const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
// Import the Candidate model at the very top of routes/jobs.js
const Candidate = require('../models/Candidate');

// 1. Import your bouncer (Middleware)
const verifyToken = require('../middleware/verifyToken'); 

// 2. The POST route to create a new job
router.post('/', verifyToken, async (req, res) => {
  try {
    if (!req.body.title || !req.body.description) {
      return res.status(400).json({ error: "Title and description are required." });
    }

    const newJob = new Job({
      title: req.body.title,
      description: req.body.description,
      requiredSkills: req.body.requiredSkills || [],
      interviewTopics: req.body.interviewTopics || [],
      adminId: req.admin.adminId // Safely grabbing from the verified cookie
    });

    await newJob.save();
    res.status(201).json({ message: "Job successfully created!", job: newJob });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create job." });
  }
});
// GET /api/jobs - Fetch all active jobs for the public career page
router.get('/', async (req, res) => {
  try {
    // .sort({ createdAt: -1 }) puts the newest jobs at the top
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.status(200).json(jobs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch jobs." });
  }
});

// GET /api/jobs/stats/dashboard - Get HR Analytics
router.get('/stats/dashboard', verifyToken, async (req, res) => {
  try {
    const adminId = req.admin.adminId;

    // 1. Find all jobs created by this specific HR Admin
    const myJobs = await Job.find({ adminId: adminId });
    const jobIds = myJobs.map(job => job._id);

    // 2. Find all candidates who applied to ANY of those jobs
    const candidates = await Candidate.find({ appliedJobId: { $in: jobIds } });

    // 3. Calculate the stats
    const totalJobs = myJobs.length;
    const totalApplicants = candidates.length;
    
    // Calculate average ATS Match Score (ignoring candidates who haven't been scored yet)
    const scoredCandidates = candidates.filter(c => c.atsMatchScore !== null);
    let avgScore = 0;
    if (scoredCandidates.length > 0) {
      const totalScore = scoredCandidates.reduce((sum, c) => sum + c.atsMatchScore, 0);
      avgScore = (totalScore / scoredCandidates.length).toFixed(1);
    }

    res.status(200).json({
      totalJobs,
      totalApplicants,
      averageMatchScore: avgScore,
      recentActivity: candidates.slice(-5) // Send the 5 most recent applicants
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load analytics dashboard." });
  }
});

// GET /api/jobs/:jobId - Fetch a single job's details
router.get('/:jobId', async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    res.status(200).json(job);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch job details." });
  }
});
// GET /api/jobs/:jobId/candidates - Fetch the ranked leaderboard
router.get('/:jobId/candidates', verifyToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    // Find all candidates who applied for this specific job
    // .sort({ atsMatchScore: -1 }) puts the highest scores at the very top!
    const candidates = await Candidate.find({ appliedJobId: jobId })
      .select('-resumeText') // We exclude the massive resume text to make the API faster
      .sort({ atsMatchScore: -1 });

    res.status(200).json(candidates);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch candidates." });
  }
});

// PUT /api/jobs/:jobId - Update a job posting
router.put('/:jobId', verifyToken, async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });

    // Security Check: Make sure this admin actually owns this job
    if (job.adminId.toString() !== req.admin.adminId) {
      return res.status(403).json({ error: "Unauthorized to edit this job." });
    }

    // Update the job with new data
    const updatedJob = await Job.findByIdAndUpdate(
      req.params.jobId, 
      { $set: req.body }, 
      { new: true }
    );
    res.status(200).json({ message: "Job updated!", job: updatedJob });
  } catch (error) {
    res.status(500).json({ error: "Failed to update job." });
  }
});

// DELETE /api/jobs/:jobId - Delete a job posting
router.delete('/:jobId', verifyToken, async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });

    if (job.adminId.toString() !== req.admin.adminId) {
      return res.status(403).json({ error: "Unauthorized to delete this job." });
    }

    await Job.findByIdAndDelete(req.params.jobId);
    res.status(200).json({ message: "Job successfully deleted." });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete job." });
  }
});
// DELETE /api/jobs/:jobId/candidates/:candidateId — Remove a candidate record
router.delete('/:jobId/candidates/:candidateId', verifyToken, async (req, res) => {
  try {
    const { jobId, candidateId } = req.params;

    // Confirm the candidate actually belongs to this job (prevent cross-job deletion)
    const candidate = await Candidate.findOne({ _id: candidateId, appliedJobId: jobId });
    if (!candidate) {
      return res.status(404).json({ error: "Candidate not found for this job." });
    }

    await Candidate.findByIdAndDelete(candidateId);
    console.log(`[DB DELETE] Candidate '${candidate.name}' (${candidateId}) deleted by admin ${req.admin.adminId}`);

    res.status(200).json({ message: "Candidate successfully deleted.", candidateId });
  } catch (error) {
    console.error("[DB DELETE] Error deleting candidate:", error.message);
    res.status(500).json({ error: "Failed to delete candidate." });
  }
});

// IMPORTANT: You must export the router so server.js can read it!
module.exports = router;