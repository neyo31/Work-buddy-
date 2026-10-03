require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
    res.json({ status: 'online', app: 'WORK BUDDY' });
});

const verifyTokensAndAuth = async (req, res, next) => {
    const userTokens = 25; 
    if (userTokens <= 0) {
        return res.status(403).json({ error: "You don’t have enough Work Buddy tokens to start this task." });
    }
    req.userTokens = userTokens;
    next();
};

app.post('/api/work-buddy/jobs', verifyTokensAndAuth, async (req, res) => {
    try {
        res.json({ 
            success: true, 
            message: "Work Buddy job started successfully.",
            status: "In progress",
            remainingTokens: req.userTokens - 1 
        });
    } catch (error) {
        res.status(500).json({ error: "Internal server error." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WORK BUDDY backend running on port ${PORT}`));
